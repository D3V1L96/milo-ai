export type Emotion =
  | "calm" | "happy" | "curious" | "sleepy" | "focused" | "confused" | "vibing"
  | "joyful" | "excited" | "content" | "relaxed" | "hopeful" | "grateful" | "loving"
  | "playful" | "mischievous" | "proud" | "confident" | "determined" | "thoughtful"
  | "interested" | "surprised" | "shocked" | "amazed" | "worried" | "anxious"
  | "nervous" | "scared" | "angry" | "annoyed" | "frustrated" | "disappointed"
  | "sad" | "lonely" | "melancholy" | "embarrassed" | "shy" | "guilty" | "jealous"
  | "skeptical" | "suspicious" | "bored" | "tired" | "exhausted" | "sick" | "dreamy"
  | "stern" | "triumphant";
export type SpeechLanguage = "en-IN" | "hi-IN" | "en-US";
export type MiloState =
  | "IDLE" | "LISTENING" | "THINKING" | "RESEARCH" | "SPEAKING"
  | "WORKING" | "SUCCESS" | "ERROR" | "VIBING";

export type NotifKind = "message" | "system" | "task" | "alert" | "call";
export type CallDirection = "incoming" | "outgoing" | "missed" | "active";
export type NotifPriority = "low" | "normal" | "high";

export interface Notification {
  id: string; kind: NotifKind; app: string; title: string; body: string;
  appId?: string; ts: number; priority: NotifPriority; read: boolean;
  callDirection?: CallDirection;
}

export interface ResearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ResearchStatus {
  query: string;
  status: "searching" | "complete" | "error";
  results: ResearchResult[];
  error?: string;
}

export interface ReminderItem { id: string; title: string; dueAt: string }

export interface ChatMessageEvent {
  requestId: string;
  role: "assistant";
  content: string;
  error?: boolean;
}

export interface LlmStatus {
  available: boolean;
  installed: boolean;
  model: string;
  error?: string;
}

export interface MiloEvent {
  source?: string;
  state?: MiloState;
  emotion?: Emotion;
  message?: string;
  progress?: number;
  research?: ResearchStatus;
  reminders?: ReminderItem[];
  chatMessage?: ChatMessageEvent;
  chatStatus?: { requestId: string; status: "thinking" };
  llmStatus?: LlmStatus;
  notification?: {
    id?: string; kind?: NotifKind; app?: string; appId?: string;
    title?: string; body?: string; priority?: NotifPriority;
    callDirection?: CallDirection;
  };
  notificationStatus?: { available: boolean; error?: string };
  dismiss?: string;
  clearAll?: boolean;
}
