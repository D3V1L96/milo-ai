import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check, Copy, History, Loader2, Mic, MicOff, Paperclip, Plus, RefreshCw, Send, Trash2, X
} from "lucide-react";
import type { LlmStatus, MiloState, SpeechLanguage } from "../lib/types";

interface UploadedFile {
  id: string;
  name: string;
  size: number;
}

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export interface ChatLine {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

export interface ChatHistoryItem {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatLine[];
}

interface VoiceSession {
  socket: WebSocket;
}

interface Props {
  messages: ChatLine[];
  conversations: ChatHistoryItem[];
  activeConversationId: string;
  pending: boolean;
  assistantState: MiloState;
  connected: boolean;
  llm: LlmStatus | null;
  voiceMuted: boolean;
  speaking: boolean;
  speechLanguage: SpeechLanguage;
  send: (cmd: Record<string, unknown>) => boolean;
  onSend: (text: string, fileId?: string) => void;
  onClearChat: () => void;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onListeningChange: (listening: boolean, message?: string) => void;
  onInterruptSpeech: () => void;
}

const INLINE_MARKDOWN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"']+)|\*\*([^*]+)\*\*|`([^`]+)`/g;

function renderInline(content: string) {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  INLINE_MARKDOWN.lastIndex = 0;
  while ((match = INLINE_MARKDOWN.exec(content))) {
    if (match.index > cursor) nodes.push(content.slice(cursor, match.index));
    if (match[2]) {
      nodes.push(<a key={`link-${match.index}`} href={match[2]} target="_blank" rel="noopener noreferrer">{match[1]}</a>);
    } else if (match[3]) {
      const raw = match[3];
      const url = raw.replace(/[.,!?;:]+$/, "");
      const trailing = raw.slice(url.length);
      nodes.push(<a key={`url-${match.index}`} href={url} target="_blank" rel="noopener noreferrer">{url}</a>, trailing);
    } else if (match[4]) {
      nodes.push(<strong key={`strong-${match.index}`}>{match[4]}</strong>);
    } else if (match[5]) {
      nodes.push(<code key={`code-${match.index}`}>{match[5]}</code>);
    }
    cursor = INLINE_MARKDOWN.lastIndex;
  }
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

function renderAssistantMessage(content: string) {
  return <div className="chat-rich-text">{content.split("\n").map((line, index) => {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (!line.trim()) return <div className="chat-line-gap" key={`gap-${index}`} />;
    if (heading) return <strong className="chat-response-heading" key={`heading-${index}`}>{renderInline(heading[1])}</strong>;
    if (bullet || numbered) return <div className="chat-response-list-item" key={`item-${index}`}>
      <span aria-hidden="true">{numbered ? `${numbered[0].trim().match(/^\d+/)?.[0]}.` : "•"}</span>
      <span>{renderInline((bullet || numbered)![1])}</span>
    </div>;
    return <p key={`line-${index}`}>{renderInline(line)}</p>;
  })}</div>;
}

export default function ChatPanel({
  messages, conversations, activeConversationId, pending, assistantState, connected, llm, voiceMuted, speaking, speechLanguage, send,
  onSend, onClearChat, onNewChat, onSelectConversation, onDeleteConversation, onListeningChange, onInterruptSpeech
}: Props) {
  const [draft, setDraft] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [attachmentError, setAttachmentError] = useState("");
  const [attachment, setAttachment] = useState<UploadedFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceHint, setVoiceHint] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState("");
  const [copyError, setCopyError] = useState("");
  const voiceSession = useRef<VoiceSession | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => {
    if (connected) send({ action: "llm_status" });
  }, [connected, send]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  const copyMessage = async (message: ChatLine) => {
    try {
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(message.content);
          copied = true;
        } catch { /* Fall back to the selection copy path below. */ }
      }
      if (!copied) {
        const textarea = document.createElement("textarea");
        textarea.value = message.content;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand("copy");
        textarea.remove();
        if (!copied) throw new Error("Clipboard permission is unavailable.");
      }
      setCopyError("");
      setCopiedMessageId(message.id);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedMessageId(""), 1600);
    } catch {
      setCopyError("Clipboard access is unavailable. Select the message text and copy it.");
    }
  };

  const visibleConversations = conversations.some((item) => item.id === activeConversationId)
    ? conversations
    : [{ id: activeConversationId, title: "New chat", updatedAt: Date.now(), messages: [] }, ...conversations];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pending) return;
    onSend(text, attachment?.id);
    setDraft("");
    setVoiceError("");
  };

  const uploadFile = (file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      setAttachmentError("Files must be 2 GB or smaller.");
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    setAttachmentError("");
    const formData = new FormData();
    formData.append("file", file);
    const request = new XMLHttpRequest();
    request.open("POST", "http://127.0.0.1:8765/files");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUploadProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    request.onload = () => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(request.responseText);
      } catch {
        payload = null;
      }
      if (request.status < 200 || request.status >= 300) {
        const detail = request.status === 404
          ? "File upload is unavailable. Restart the MILO backend."
          : payload && typeof payload === "object" && "detail" in payload
          && typeof payload.detail === "string"
          ? payload.detail
          : `Upload failed (${request.status}).`;
        setAttachmentError(detail);
        setUploading(false);
        return;
      }
      if (
        !payload || typeof payload !== "object"
        || !("id" in payload) || typeof payload.id !== "string"
        || !("name" in payload) || typeof payload.name !== "string"
        || !("size" in payload) || typeof payload.size !== "number"
      ) {
        setAttachmentError("The server returned an invalid file reference.");
        setUploading(false);
        return;
      }
      setAttachment({ id: payload.id, name: payload.name, size: payload.size });
      setUploadProgress(100);
      setUploading(false);
    }
    request.onerror = () => {
      setAttachmentError("Could not reach the MILO file upload service.");
      setUploading(false);
    };
    request.onabort = () => {
      setAttachmentError("File upload was cancelled.");
      setUploading(false);
    };
    try {
      request.send(formData);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Could not start file upload.");
      setUploading(false);
    }
  };

  const sendMessage = (text: string) => onSend(text, attachment?.id);

  const stopListening = () => {
    const session = voiceSession.current;
    if (!session) return;
    voiceSession.current = null;
    setVoiceActive(false);
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ action: "stop" }));
    } else if (session.socket.readyState === WebSocket.CONNECTING) {
      session.socket.close();
    }
    onListeningChange(false);
  };

  useEffect(() => () => {
    const session = voiceSession.current;
    voiceSession.current = null;
    if (!session) return;
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ action: "stop" }));
    } else if (session.socket.readyState === WebSocket.CONNECTING) {
      session.socket.close();
    }
  }, []);

  const handleTranscript = (session: VoiceSession, rawText: string) => {
    if (voiceSession.current !== session) return;
    const text = rawText.trim();
    if (!text) return;
    setVoiceHint(`I heard: ${text}`);
    sendMessage(text);
  };

  const startListening = async () => {
    setVoiceError("");
    setVoiceHint("Starting microphone...");
    setVoiceActive(true);
    onInterruptSpeech();
    try {
      const socket = new WebSocket("ws://127.0.0.1:8765/voice");
      const session: VoiceSession = { socket };
      voiceSession.current = session;
      socket.onopen = () => {
        if (voiceSession.current !== session) return;
        socket.send(JSON.stringify({ action: "start", language: speechLanguage }));
      };
      socket.onmessage = (event) => {
        if (voiceSession.current !== session) return;
        let payload: unknown;
        try { payload = JSON.parse(String(event.data)); }
        catch { setVoiceError("MILO received an invalid speech-service response."); stopListening(); return; }
        if (!payload || typeof payload !== "object" || !("type" in payload)) return;
        if (payload.type === "error") {
          setVoiceError("message" in payload && typeof payload.message === "string" ? payload.message : "MILO speech recognition failed.");
          stopListening();
          return;
        }
        if (payload.type === "unrecognized") {
          setVoiceHint("I couldn't catch that clearly. Please try speaking again.");
          return;
        }
        if (payload.type === "committed" && "text" in payload && typeof payload.text === "string"
            && (!("user_turn" in payload) || payload.user_turn !== false)) {
          handleTranscript(session, payload.text);
          return;
        }
        if (payload.type === "ready") {
          setVoiceHint("Listening for voice commands...");
          onListeningChange(true, "Voice commands are active. Speak anytime.");
        }
      };
      socket.onerror = () => {
        if (voiceSession.current !== session) return;
        setVoiceError("Speech service connection failed.");
        stopListening();
      };
      socket.onclose = () => {
        if (voiceSession.current !== session) return;
        voiceSession.current = null;
        setVoiceActive(false);
        onListeningChange(false);
      };
    } catch (error) {
      setVoiceActive(false);
      onListeningChange(false);
      setVoiceError(error instanceof Error ? error.message : "Could not start voice input.");
    }
  };
  const toggleListening = () => {
    if (voiceSession.current) {
      stopListening();
    } else {
      void startListening();
    }
  };

  const llmLabel = !llm
    ? "Checking local modelâ€¦"
    : !llm.available
      ? "Ollama offline"
      : llm.installed
        ? `Local Â· ${llm.model}`
        : `Model missing Â· ${llm.model}`;
  return (
    <div className="chat-panel" onClick={(event) => event.stopPropagation()}>
      <AnimatePresence>
        {historyOpen && <>
          <motion.button type="button" className="chat-history-backdrop" aria-label="Close chat history"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setHistoryOpen(false)} />
          <motion.aside className="chat-history-drawer" aria-label="Chat history"
            initial={{ x: "-105%", opacity: 0.7 }} animate={{ x: 0, opacity: 1 }} exit={{ x: "-105%", opacity: 0.7 }}
            transition={{ type: "spring", stiffness: 420, damping: 36 }}>
            <div className="chat-history-heading">
              <strong>Chats</strong>
              <button type="button" aria-label="Close chat history" onClick={() => setHistoryOpen(false)}><X size={13} /></button>
            </div>
            <button type="button" className="chat-history-new" onClick={() => { onNewChat(); setHistoryOpen(false); }}>
              <Plus size={13} /> New chat
            </button>
            <div className="chat-history-list">
              {visibleConversations.map((conversation) => (
                <div className={`chat-history-item ${conversation.id === activeConversationId ? "active" : ""}`} key={conversation.id}>
                  <button type="button" className="chat-history-select" aria-current={conversation.id === activeConversationId ? "page" : undefined}
                    onClick={() => { onSelectConversation(conversation.id); setHistoryOpen(false); }}>
                    <strong>{conversation.title}</strong>
                    <small>{conversation.messages.length} messages · {conversation.updatedAt ? new Date(conversation.updatedAt).toLocaleDateString() : "New"}</small>
                  </button>
                  {conversation.messages.length > 0 && <button type="button" className="chat-history-delete"
                    aria-label={`Delete chat: ${conversation.title}`} title="Delete chat"
                    onClick={() => onDeleteConversation(conversation.id)}><Trash2 size={12} /></button>}
                </div>
              ))}
              {visibleConversations.length === 0 && <p className="chat-history-empty">Your previous chats will appear here.</p>}
            </div>
          </motion.aside>
        </>}
      </AnimatePresence>
      <div className="chat-toolbar">
        <button type="button" className={`chat-history-toggle ${historyOpen ? "active" : ""}`}
          aria-label={historyOpen ? "Close chat history" : "Open chat history"} aria-expanded={historyOpen}
          title="Chat history" onClick={() => setHistoryOpen((open) => !open)}>
          <History size={13} />
        </button>
        <button
          type="button"
          className={`llm-status ${llm?.available && llm.installed ? "ready" : ""}`}
          onClick={() => send({ action: "llm_status" })}
          aria-label={`Check local model status: ${llmLabel}`}
          title={llm?.error || "Check local Ollama status"}
        >
          <span className="llm-dot" />
          <span title={llm?.error}>{llmLabel}</span>
          <RefreshCw size={11} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="chat-clear"
          onClick={onClearChat}
          aria-label="Clear chat"
          title="Delete all messages in this chat"
        >
          <Trash2 size={12} />
        </button>
        <div className="chat-voice-controls">
          <span className={speaking || voiceActive ? "speaking-label active" : "speaking-label"}>
            {voiceActive ? "Listening for commands" : speaking ? "MILO chiming" : voiceMuted ? "Sounds muted" : "Sound cues on"}
          </span>
        </div>
      </div>

      <div className="chat-messages" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 && (
          <div className="chat-welcome">
            <strong>Talk to MILO</strong>
            <span>Ask naturally in English or Hinglish. For current information, MILO searches the web and adds source links.</span>
            <div className="chat-suggestions" aria-label="Try a prompt">
              {[
                "What's new in AI today?",
                "Explain a tricky topic simply",
                "Summarize this week's tech news",
              ].map((prompt) => <button key={prompt} type="button" disabled={!connected || pending}
                onClick={() => onSend(prompt)}>{prompt}</button>)}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <div className={`chat-bubble ${message.role}${message.error ? " error" : ""}`} key={message.id}>
            <div className="chat-message-content">
              {message.role === "assistant" ? renderAssistantMessage(message.content) : message.content}
            </div>
            <button type="button" className="chat-message-copy" aria-label={`Copy ${message.role} message`}
              title={copiedMessageId === message.id ? "Copied" : "Copy message"}
              onClick={() => { void copyMessage(message); }}>
              {copiedMessageId === message.id ? <Check size={11} /> : <Copy size={11} />}
              <span>{copiedMessageId === message.id ? "Copied" : "Copy"}</span>
            </button>
          </div>
        ))}
        {pending && (
          <div className="chat-thinking" role="status">
            <Loader2 className="spin" size={13} /> {assistantState === "RESEARCH" ? "Searching the web and checking sources…" : "MILO is putting together a clear answer…"}
          </div>
        )}
        <div ref={bottom} />
      </div>

      {voiceError && <p className="chat-error" role="alert">{voiceError}</p>}
      {copyError && <p className="chat-hint" role="status">{copyError}</p>}
      {voiceActive && voiceHint && <p className="chat-hint" role="status">{voiceHint}</p>}
      {!connected && <p className="chat-error" role="alert">MILO backend is offline.</p>}
      {attachment && (
        <div className="chat-attachment">
          <span>{attachment.name} Â· {(attachment.size / 1024).toFixed(0)} KB</span>
          <button
            type="button"
            aria-label={`Remove ${attachment.name}`}
            title="Remove attachment"
            onClick={() => {
              setAttachment(null);
              setAttachmentError("");
            }}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {uploading && (
        <p className="chat-hint" role="status">
          Uploading fileâ€¦ {uploadProgress}%
        </p>
      )}
      {attachmentError && <p className="chat-error" role="alert">{attachmentError}</p>}
      {llm?.error && (
        <p className="chat-hint">{llm.error}</p>
      )}
      <input
        ref={fileInput}
        type="file"
        className="chat-file-input"
        aria-label="Choose a file to attach"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void uploadFile(file);
        }}
      />
      <form className="chat-input" onSubmit={submit}>
        <button
          type="button"
          className="chat-icon-btn"
          aria-label="Attach a file, maximum 2 GB"
          title="Attach a file (max 2 GB)"
          onClick={() => fileInput.current?.click()}
          disabled={pending || uploading || !connected}
        >
          {uploading ? <Loader2 className="spin" size={15} /> : <Paperclip size={15} />}
        </button>
        <button
          type="button"
          className={`chat-icon-btn ${voiceActive ? "listening" : ""}`}
          onClick={toggleListening}
          aria-label={voiceActive ? "Stop voice commands" : "Start voice commands"}
          aria-pressed={voiceActive}
          disabled={uploading || !connected || (pending && !voiceActive)}
          title={voiceActive ? "Stop voice commands" : "Start microphone and speak commands directly"}
        >
          {voiceActive ? <MicOff size={15} /> : <Mic size={15} />}
        </button>
        <input
          value={draft}
          maxLength={4000}
          aria-label="Message MILO"
          placeholder={voiceActive ? "Listeningâ€¦" : "Message MILOâ€¦"}
          onChange={(event) => setDraft(event.target.value)}
          disabled={pending || uploading}
        />
        <button type="submit" className="chat-send" aria-label="Send message"
          disabled={!draft.trim() || pending || uploading || !connected}>
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}

