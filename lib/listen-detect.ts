import { getDownlink } from "./downlink-owner";
import { CONVERSATION_IDLE_MS, noteDeviceActivity } from "./idle-disconnect";
import { getRealtimeBridge } from "./realtime-bridge";
import { patchConnection } from "./device-registry";

/** Official xiaozhi-esp32-server wakeup_words (punctuation stripped). */
export const DEFAULT_WAKE_WORDS = [
  "你好小智",
  "嘿你好呀",
  "你好小志",
  "小爱同学",
  "你好小鑫",
  "你好小新",
  "小美同学",
  "小龙小龙",
  "喵喵同学",
  "小滨小滨",
  "小冰小冰",
];

/** Official greeting used as startToChat text when enable_greeting is on. */
export const WAKE_GREETING = "嘿，你好呀";

export type DetectKind = "wake-ack" | "wake-greet" | "chat";

export type DetectPlan = {
  kind: DetectKind;
  sttText: string;
  sendTtsStop: boolean;
  chatText: string | null;
};

export function normalizeWakeText(text: string): string {
  return text.replace(/[^\u4e00-\u9fff\w]/g, "").toLowerCase();
}

export function isWakeWord(text: string, wakeWords = DEFAULT_WAKE_WORDS): boolean {
  const normalized = normalizeWakeText(text);
  if (!normalized) return false;
  return wakeWords.some((word) => normalizeWakeText(word) === normalized);
}

/**
 * Official ListenTextMessageHandler detect semantics:
 * - wake + greeting off → STT + tts stop (Listening resumes)
 * - wake + greeting on  → STT + tts stop, then chat starter「嘿，你好呀」
 * - other detect text   → STT + tts stop, then chat with that text
 *
 * tts stop is always included so a prior tts start cannot leave the board Speaking.
 */
export function planDetect(
  text: string,
  options: { enableGreeting?: boolean } = {},
): DetectPlan {
  const sttText = text.trim();
  const enableGreeting = options.enableGreeting !== false;
  if (!sttText) {
    return { kind: "wake-ack", sttText: "", sendTtsStop: true, chatText: null };
  }
  if (isWakeWord(sttText)) {
    if (!enableGreeting) {
      return { kind: "wake-ack", sttText, sendTtsStop: true, chatText: null };
    }
    return { kind: "wake-greet", sttText, sendTtsStop: true, chatText: WAKE_GREETING };
  }
  return { kind: "chat", sttText, sendTtsStop: true, chatText: sttText };
}

export type DetectApplyResult = DetectPlan & {
  greetedViaRealtime: boolean;
};

export function applyListenDetect(args: {
  sessionId: string;
  text?: string;
  sendJson: (payload: unknown) => void;
  enableGreeting?: boolean;
}): DetectApplyResult {
  const plan = planDetect(args.text ?? "", { enableGreeting: args.enableGreeting });
  noteDeviceActivity(args.sessionId, CONVERSATION_IDLE_MS);

  if (plan.sttText) {
    args.sendJson({ session_id: args.sessionId, type: "stt", text: plan.sttText });
  }

  const bridge = getRealtimeBridge(args.sessionId);
  bridge?.acknowledgeDetect();

  if (plan.sendTtsStop) {
    args.sendJson({ session_id: args.sessionId, type: "tts", state: "stop" });
    if (getDownlink(args.sessionId).owner !== "play") {
      patchConnection(args.sessionId, { playing: false, responding: false });
    }
  }

  let greetedViaRealtime = false;
  if (plan.chatText && bridge) {
    bridge.startTextTurn(plan.chatText);
    greetedViaRealtime = true;
  }

  return { ...plan, greetedViaRealtime };
}
