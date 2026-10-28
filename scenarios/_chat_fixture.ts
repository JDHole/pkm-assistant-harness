/** Minimalny gospodarz czatu w Node. DOM i zapis sesji są atrapami I/O. */
import { RollingWindow } from '@plugin/modules/chat/chat/RollingWindow.js';
import { append_message } from '@plugin/modules/chat/chat/chat_messages.js';
import { send_message, set_generating, _finalizeTurn, _releaseStreamCtx, _drainSubTasks, _chatExecuteToolCall, _deliverSubTaskQuestion, _deliverSubTaskResult } from '@plugin/modules/chat/chat/chat_streaming.js';
import { createModelForRole } from '@plugin/modules/models/index.js';
import { createMockEl } from '../test-support/dom-shim.js';
import { resolveToolsForAgent } from '../lib/runTurn.js';
import type { FixturePayload } from './_asserts.js';

export function chatFixture(plugin: FixturePayload, origin: FixturePayload, beforeSave?: () => Promise<void>) {
  const window = new RollingWindow();
  const events: FixturePayload[] = [];
  const errors: unknown[] = [];
  const turns = { activeQuestions: 0, maxQuestions: 0, completed: 0, active: 0 };
  const memory = { activeSessionPath: origin.sessionPath, sessionEpoch: origin.sessionEpoch,
    async appendSessionEvent(_path: string, event: FixturePayload) { events.push(event); await beforeSave?.(); } };
  const actualManager = plugin.agentManager;
  const agentManager = { getActiveAgent: () => actualManager.getActiveAgent(), getAgentMemory: () => memory,
    getActiveSystemPromptWithMemory: (...args: FixturePayload[]) => actualManager.getActiveSystemPromptWithMemory(...args) };
  const chatPlugin = Object.create(plugin);
  chatPlugin.agentManager = agentManager;
  if (!document.hasFocus) document.hasFocus = () => true;
  const tab = { ...origin, sessionId: origin.tabKey, isActive: true };
  const view: FixturePayload = {
    leaf: { id: 'harness-chat' }, chatTabs: [tab], rollingWindow: window, plugin: chatPlugin, env: plugin.env,
    input_area: { value: '', focus() {} }, inputHistory: [], tokenTracker: { record() {} },
    send_button: createMockEl(), stop_button: createMockEl(),
    messages_container: createMockEl(), _autoTurnChainCounts: new Map(), _preparingTurns: new Map(),
    _streamCtxMap: new Map(), _agentStates: new Map(), _questionAutoTurn: { kind: 'idle' },
    _subTaskTurnPending: false, is_generating: false, _drainSuppressed: false, currentAutonomy: 'yolo',
    append_message: (...args: FixturePayload[]) => append_message.call(view, ...args as [any, any, any, any]),
    updateTokenCounter() {}, scrollToBottom() {}, _buildActiveNoteContext: async () => null,
    appendToActiveSession: async (event: FixturePayload) => { events.push(event); },
    async send_message(opts: FixturePayload) {
      turns.active++;
      if (opts.questionDelivery) {
        turns.activeQuestions++;
        turns.maxQuestions = Math.max(turns.maxQuestions, turns.activeQuestions);
      }
      try { return await send_message.call(view, opts); }
      finally { turns.active--; if (opts.questionDelivery) { turns.activeQuestions--; turns.completed++; } }
    },
    set_generating, _drainSubTasks, _releaseStreamCtx, _finalizeTurn,
    showTypingIndicator() {}, hideTypingIndicator() {}, _hideQueuedIndicator() {}, _resetPaintTargets() {},
    scrollToFinalMessage() {}, _scheduleConnectorRedraw() {}, _updateTokenPanel() {}, handle_chunk() {},
    _renderCacheSavingsBadge() {}, addMessageActions() {},
    _ensureAgentMessageContainer() { view.current_message_container = createMockEl(); view.current_message_text = createMockEl(); },
    get_chat_model: ({ agent }: FixturePayload) => createModelForRole(plugin, 'main', agent),
    _chatResolveTools: (turn: FixturePayload) => resolveToolsForAgent(plugin, turn.agent),
    _chatExecuteToolCall,
    _chatOnIterationStart() {}, _chatOnToolCallsParsed() {}, _chatOnToolResults() {},
    _chatBeforeContinue() {}, _chatOnUsage() {}, _chatOnBackstop() {}, _isTurnActiveTab: () => true,
    handle_error(error: unknown) { errors.push(error); view.is_generating = false; },
  };
  plugin.subTaskNotifier.setNoticeDeliverer((notice: FixturePayload) => notice.kind === 'question'
    ? _deliverSubTaskQuestion.call(view, notice.question) : _deliverSubTaskResult.call(view, notice.task));
  return { view, window, events, errors, turns };
}
