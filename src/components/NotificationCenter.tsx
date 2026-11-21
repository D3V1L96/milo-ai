import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Trash2, Inbox } from "lucide-react";
import NotificationCard from "./NotificationCard";
import type { Notification } from "../lib/types";

type NotificationView = "inbox" | "kept";

export default function NotificationCenter({
  items, keptItems, unread, storageError, status,
  onKeep, onDelete, onRestore, onRead, onOpen, onReply, onClear
}: {
  items: Notification[];
  keptItems: Notification[];
  unread: number;
  storageError: string;
  status: { available: boolean; error?: string } | null;
  onKeep: (id: string) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  onRead: (id: string) => void;
  onOpen: (notification: Notification) => void;
  onReply: (notification: Notification, reply: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [view, setView] = useState<NotificationView>("inbox");
  const currentItems = view === "inbox" ? items : keptItems;
  const visible = expanded ? currentItems : currentItems.slice(0, 3);

  return (
    <div className="nc">
      <div className="nc-bar">
        <button className="nc-toggle" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          <Inbox size={12} />
          <span>{view === "inbox" ? `${unread} new` : `${keptItems.length} kept`}</span>
          <span className={`dot ${status?.available ? "live" :
            status?.available === false ? "notification-offline" : ""}`} />
          <motion.span animate={{ rotate: expanded ? 180 : 0 }} style={{ display: "grid" }}>
            <ChevronDown size={12} />
          </motion.span>
        </button>
        {(items.length > 0 || keptItems.length > 0) && (
          <button className="nc-clear" onClick={onClear} aria-label="Clear all notifications"
            title="Clear inbox and kept notifications"><Trash2 size={12} /></button>
        )}
      </div>

      <div className="nc-tabs" role="tablist" aria-label="Notification status">
        <button role="tab" aria-selected={view === "inbox"} onClick={() => setView("inbox")}>
          Inbox <span>{items.length}</span>
        </button>
        <button role="tab" aria-selected={view === "kept"} onClick={() => setView("kept")}>
          Kept <span>{keptItems.length}</span>
        </button>
      </div>

      {status?.available === false && (
        <p className="nc-status error" role="status">
          Windows notifications unavailable{status.error ? `: ${status.error}` : "."}
        </p>
      )}
      {storageError && <p className="nc-status error" role="alert">{storageError}</p>}

      <motion.div className="nc-list" layout>
        <AnimatePresence initial={false} mode="popLayout">
          {visible.map((n, i) => (
            <motion.div key={n.id} layout style={{ zIndex: visible.length - i }}
              animate={!expanded ? { scale: 1 - i * 0.035, y: i * -6 } : { scale: 1, y: 0 }}>
              <NotificationCard
                n={n}
                kept={view === "kept"}
                onKeep={onKeep}
                onDelete={onDelete}
                onRestore={onRestore}
                onRead={onRead}
                onOpen={onOpen}
                onReply={onReply}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>

      {!currentItems.length && (
        <p className="nc-empty">
          {view === "inbox" ? "No incoming notifications." : "Nothing kept yet."}
        </p>
      )}
      {!expanded && currentItems.length > 3 && (
        <button className="nc-more" onClick={() => setExpanded(true)}>
          +{currentItems.length - 3} more
        </button>
      )}
    </div>
  );
}
