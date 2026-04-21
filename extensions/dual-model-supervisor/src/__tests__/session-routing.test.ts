import { describe, expect, it } from 'vitest';
import { TurnRegistry } from '../core/turn-context.js';
import { SessionAnchorsRegistry } from '../core/session-anchors.js';

describe('TurnRegistry: per-session turn isolation', () => {
  it('creates independent turns for different sessions', () => {
    const registry = new TurnRegistry();
    
    const turnA = registry.create('session-a', 'Hello A');
    const turnB = registry.create('session-b', 'Hello B');
    
    expect(turnA.sessionId).toBe('session-a');
    expect(turnB.sessionId).toBe('session-b');
    expect(turnA.turnSeq).toBe(1);
    expect(turnB.turnSeq).toBe(1);
    
    // Sessions should not interfere
    expect(registry.listSessions()).toHaveLength(2);
    expect(registry.listActive('session-a')).toHaveLength(1);
    expect(registry.listActive('session-b')).toHaveLength(1);
  });

  it('increments turnSeq per session independently', () => {
    const registry = new TurnRegistry();
    
    const turnA1 = registry.create('session-a', 'Message 1');
    const turnA2 = registry.create('session-a', 'Message 2');
    const turnB1 = registry.create('session-b', 'Message 1');
    
    expect(turnA1.turnSeq).toBe(1);
    expect(turnA2.turnSeq).toBe(2);
    expect(turnB1.turnSeq).toBe(1);
  });

  it('advances phase independently per turn', () => {
    const registry = new TurnRegistry();
    
    const turn = registry.create('session-a', 'Test');
    expect(turn.phase).toBe('received');
    
    registry.advancePhase(turn, 'llm_input');
    expect(turn.phase).toBe('llm_input');
    
    registry.advancePhase(turn, 'llm_output');
    expect(turn.phase).toBe('llm_output');
    
    // Idempotent: going backwards is no-op
    registry.advancePhase(turn, 'llm_input');
    expect(turn.phase).toBe('llm_output');
  });

  it('finishes turn and removes from active list', () => {
    const registry = new TurnRegistry();
    
    const turn = registry.create('session-a', 'Test');
    expect(registry.listActive('session-a')).toHaveLength(1);
    
    registry.finish(turn);
    expect(registry.listActive('session-a')).toHaveLength(0);
    expect(turn.phase).toBe('sent');
  });

  it('resolves correct turn by phase', () => {
    const registry = new TurnRegistry();
    
    const turn1 = registry.create('session-a', 'Message 1');
    registry.advancePhase(turn1, 'llm_output');
    
    const turn2 = registry.create('session-a', 'Message 2');
    // turn2 is still in 'received' phase
    
    // Should resolve turn2 for 'llm_input' (phase < required)
    const resolved = registry.resolve('session-a', 'llm_input');
    expect(resolved).toBeDefined();
    expect(resolved!.turnSeq).toBe(2); // turn2 is the one that can advance
  });

  it('resolves correct turn by fingerprint', () => {
    const registry = new TurnRegistry();
    
    registry.create('session-a', 'Message 1');
    registry.create('session-a', 'Message 2');
    
    const resolved = registry.resolve('session-a', 'llm_input', { userMessage: 'Message 2' });
    expect(resolved).toBeDefined();
    expect(resolved!.userMessage).toBe('Message 2');
  });

  it('drops all turns for a session', () => {
    const registry = new TurnRegistry();
    
    registry.create('session-a', 'Message 1');
    registry.create('session-a', 'Message 2');
    expect(registry.listActive('session-a')).toHaveLength(2);
    
    registry.dropSession('session-a');
    expect(registry.listActive('session-a')).toHaveLength(0);
    expect(registry.listSessions()).toHaveLength(0);
  });
});

describe('SessionAnchorsRegistry: per-session state isolation', () => {
  it('maintains independent anchors per session', () => {
    const registry = new SessionAnchorsRegistry();
    
    registry.merge('session-a', { researchGoal: 'Goal A', goalConfirmed: true });
    registry.merge('session-b', { researchGoal: 'Goal B', goalConfirmed: true });
    
    expect(registry.view('session-a').researchGoal).toBe('Goal A');
    expect(registry.view('session-b').researchGoal).toBe('Goal B');
  });

  it('merges anchors independently per session', () => {
    const registry = new SessionAnchorsRegistry();
    
    registry.merge('session-a', {
      researchGoal: 'Goal A',
      targetConclusions: ['Conclusion A'],
      goalConfirmed: true,
    });
    
    registry.merge('session-b', {
      researchGoal: 'Goal B',
      keyConclusions: ['Key B'],
      goalConfirmed: true,
    });
    
    const anchorsA = registry.view('session-a');
    const anchorsB = registry.view('session-b');
    
    expect(anchorsA.researchGoal).toBe('Goal A');
    expect(anchorsA.targetConclusions).toEqual(['Conclusion A']);
    expect(anchorsA.keyConclusions).toEqual([]); // Not set for A
    
    expect(anchorsB.researchGoal).toBe('Goal B');
    expect(anchorsB.keyConclusions).toEqual(['Key B']);
    expect(anchorsB.targetConclusions).toEqual([]); // Not set for B
  });

  it('enqueues and drains prepend blocks independently per session', () => {
    const registry = new SessionAnchorsRegistry();
    
    registry.enqueueBlock('session-a', { type: 'previousReview', text: 'Review A' });
    registry.enqueueBlock('session-b', { type: 'previousReview', text: 'Review B' });
    
    const blocksA = registry.drainBlocks('session-a');
    const blocksB = registry.drainBlocks('session-b');
    
    expect(blocksA).toHaveLength(1);
    expect(blocksA[0]?.type === 'previousReview' ? blocksA[0].text : '').toBe('Review A');
    
    expect(blocksB).toHaveLength(1);
    expect(blocksB[0]?.type === 'previousReview' ? blocksB[0].text : '').toBe('Review B');
    
    // After draining, should be empty
    expect(registry.drainBlocks('session-a')).toHaveLength(0);
    expect(registry.drainBlocks('session-b')).toHaveLength(0);
  });

  it('caps review reports per session independently', () => {
    const registry = new SessionAnchorsRegistry();
    
    // Add 7 reports to session-a (cap is 5)
    for (let i = 0; i < 7; i++) {
      registry.pushReviewReport('session-a', `Report ${i}`);
    }
    
    // Add 3 reports to session-b
    for (let i = 0; i < 3; i++) {
      registry.pushReviewReport('session-b', `Report ${i}`);
    }
    
    const anchorsA = registry.view('session-a');
    const anchorsB = registry.view('session-b');
    
    expect(anchorsA.recentReviewReports).toHaveLength(5); // Capped at 5
    expect(anchorsB.recentReviewReports).toHaveLength(3); // Not capped
  });

  it('drops session data on drop', () => {
    const registry = new SessionAnchorsRegistry();
    
    registry.merge('session-a', { researchGoal: 'Goal A', goalConfirmed: true });
    expect(registry.view('session-a').researchGoal).toBe('Goal A');
    expect(registry.listSessions()).toContain('session-a');
    
    registry.drop('session-a');
    // After drop, the session is removed from the registry
    expect(registry.listSessions()).not.toContain('session-a');
    expect(registry.listSessions()).toHaveLength(0);
    // view() lazily recreates if accessed again
    expect(registry.view('session-a').researchGoal).toBeUndefined();
  });
});

describe('Cross-component integration: session isolation', () => {
  it('TurnRegistry and SessionAnchorsRegistry work independently', () => {
    const turnRegistry = new TurnRegistry();
    const anchorRegistry = new SessionAnchorsRegistry();
    
    // Session A
    const turnA = turnRegistry.create('session-a', 'Hello');
    anchorRegistry.merge('session-a', { researchGoal: 'Research A', goalConfirmed: true });
    
    // Session B
    const turnB = turnRegistry.create('session-b', 'World');
    anchorRegistry.merge('session-b', { researchGoal: 'Research B', goalConfirmed: true });
    
    // Verify isolation
    expect(turnRegistry.listActive('session-a')[0].userMessage).toBe('Hello');
    expect(turnRegistry.listActive('session-b')[0].userMessage).toBe('World');
    expect(anchorRegistry.view('session-a').researchGoal).toBe('Research A');
    expect(anchorRegistry.view('session-b').researchGoal).toBe('Research B');
    
    // Finish session A turn should not affect session B
    turnRegistry.finish(turnA);
    expect(turnRegistry.listActive('session-a')).toHaveLength(0);
    expect(turnRegistry.listActive('session-b')).toHaveLength(1);
  });
});
