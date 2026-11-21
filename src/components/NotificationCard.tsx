import { useState } from "react";
import { motion, useMotionValue, useTransform, type PanInfo } from "framer-motion";
import {
  MessageCircle, Bell, Cog, AlertTriangle, Bookmark, Inbox, MoreHorizontal, Trash2, Send,
  PhoneCall, PhoneIncoming, PhoneOutgoing
} from "lucide-react";
import type { Notification, NotifKind } from "../lib/types";

const ICON: Record<NotifKind, typeof Bell> = {
  message: MessageCircle, system: Cog, task: Bell, alert: AlertTriangle, call: PhoneCall
};

const ago = (ts: number) => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

function canOpenApp(notification: Notification): boolean {
  return Boolean(notification.appId) ||
    !["system", "windows", "milo"].includes(notification.app.trim().toLowerCase());
}

export default function NotificationCard({
  n, kept, onKeep, onDelete, onRestore, onRead, onOpen, onReply
}: {
  n: Notification;
  kept: boolean;
  onKeep: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onRead: (id: string) => void;
  onOpen: (notification: Notification) => void;
  onReply: (notification: Notification, reply: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replyStatus, setReplyStatus] = useState("");
  const x = useMotionValue(0);
  const opacity = useTransform(x, [-160, -40, 0, 40, 160], [0, 1, 1, 1, 0]);
  const rotate = useTransform(x, [-160, 0, 160], [-6, 0, 6]);
  const Icon = n.kind === "call"
    ? n.callDirection === "incoming" || n.callDirection === "missed" ? PhoneIncoming
      : n.callDirection === "outgoing" ? PhoneOutgoing : PhoneCall
    : ICON[n.kind];
  const callLabel = n.kind === "call"
    ? n.callDirection === "incoming" ? "Incoming call"
      : n.callDirection === "missed" ? "Missed call"
        : n.callDirection === "outgoing" ? "Outgoing call" : "Call"
    : "";
  const launchable = canOpenApp(n);

  const end = (_: unknown, info: PanInfo) => {
    if (Math.abs(info.offset.x) > 65 || Math.abs(info.velocity.x) > 400) {
      setActionsVisible(true);
    }
  };

  const activate = () => {
    onRead(n.id);
    if (launchable) onOpen(n);
    else setOpen((currentlyOpen) => !currentlyOpen);
  };

  return (
    <motion.div
      layout
      className={`notif ${n.kind} ${n.read ? "read" : ""}`}
      style={{ x, opacity, rotate }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.5}
      onDragEnd={end}
      initial={{ opacity: 0, y: -18, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 220, scale: 0.9, transition: { duration: 0.2 } }}
      transition={{ type: "spring", stiffness: 340, damping: 30 }}
      onClick={activate}
      role="button"
      tabIndex={0}
      aria-label={`${n.app}: ${n.title}. ${launchable ? "Click to open app. " : ""}Swipe for Keep or Delete.`}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
        if (event.key === "Delete") onDelete(n.id);
        if (event.key === "Escape") setActionsVisible(false);
      }}
    >
      <div className="n-head">
        <span className="n-icon"><Icon size={13} /></span>
        <span className="n-app">{n.app}</span>
        {!n.read && <span className="n-dot" />}
        <span className="n-time">{ago(n.ts)}</span>
        <button className="n-x" aria-label="Show notification actions"
          onClick={(event) => {
            event.stopPropagation();
            setActionsVisible((visible) => !visible);
          }}
          onKeyDown={(event) => event.stopPropagation()}>
          <MoreHorizontal size={12} />
        </button>
      </div>
      {callLabel && <div className="n-call-label">{callLabel}</div>}
      <div className="n-title">{n.title}</div>
      <motion.div className="n-body" animate={{ height: open ? "auto" : 20 }} transition={{ duration: 0.2 }}>
        {n.body}
      </motion.div>
      {actionsVisible && (
        <div className="n-actions"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}>
          {!kept ? (
            <button type="button" onClick={() => onKeep(n.id)}>
              <Bookmark size={12} /> Keep
            </button>
          ) : (
            <button type="button" onClick={() => onRestore(n.id)}>
              <Inbox size={12} /> Inbox
            </button>
          )}
          <button type="button" className="delete" onClick={() => onDelete(n.id)}>
            <Trash2 size={12} /> Delete
          </button>
          {launchable && <span>Click card to open {n.app}</span>}
          {n.kind === "message" && launchable && <form className="n-reply" onSubmit={async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const reply = replyText.trim();
            if (!reply) return;
            if (!/whats?\s*app/i.test(n.app)) {
              setReplyStatus("Direct reply is currently available for WhatsApp notifications.");
              return;
            }
            onRead(n.id);
            onReply(n, reply);
            setReplyText("");
            setReplyStatus(`Sending reply to ${n.title} through WhatsApp… Check MILO chat for the send result.`);
          }} onClick={(event) => event.stopPropagation()}>
            <input aria-label={`Reply to ${n.app}`} placeholder="Write a reply…" maxLength={500} value={replyText} onChange={(event) => setReplyText(event.target.value)} />
            <button type="submit" aria-label="Send WhatsApp reply" disabled={!replyText.trim()}><Send size={12} /></button>
            {replyStatus && <small role="status">{replyStatus}</small>}
          </form>}
        </div>
      )}
      {!actionsVisible && <div className="n-swipe-hint">swipe for keep / delete</div>}
    </motion.div>
  );
}
