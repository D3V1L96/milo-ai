import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MiloEvent, Notification, NotifKind, NotifPriority
} from "../lib/types";

const MAX = 100;
const MAX_DELETED = 500;
const STORAGE_KEY = "milo.notifications.v1";
let seq = 0;
const uid = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

interface NotificationStore {
  items: Notification[];
  keptItems: Notification[];
  deletedIds: string[];
  error: string;
}

function isNotification(value: unknown): value is Notification {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" &&
    (item.kind === "message" || item.kind === "system" ||
      item.kind === "task" || item.kind === "alert" || item.kind === "call") &&
    typeof item.app === "string" &&
    (item.appId === undefined || typeof item.appId === "string") &&
    typeof item.title === "string" &&
    typeof item.body === "string" &&
    (item.callDirection === undefined || item.callDirection === "incoming" ||
      item.callDirection === "outgoing" || item.callDirection === "missed" ||
      item.callDirection === "active") &&
    typeof item.ts === "number" && Number.isFinite(item.ts) &&
    (item.priority === "low" || item.priority === "normal" || item.priority === "high") &&
    typeof item.read === "boolean";
}

function loadStore(): NotificationStore {
  if (typeof window === "undefined") {
    return { items: [], keptItems: [], deletedIds: [], error: "" };
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return { items: [], keptItems: [], deletedIds: [], error: "" };
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) {
      return {
        items: [], keptItems: [], deletedIds: [],
        error: "Saved notifications had an invalid format.",
      };
    }
    const store = parsed as Record<string, unknown>;
    const items = Array.isArray(store.items) ? store.items.filter(isNotification) : [];
    const keptItems = Array.isArray(store.keptItems)
      ? store.keptItems.filter(isNotification)
      : [];
    const deletedIds = Array.isArray(store.deletedIds)
      ? store.deletedIds.filter((id): id is string => typeof id === "string")
      : [];
    return {
      items: items.slice(0, MAX),
      keptItems: keptItems.slice(0, MAX),
      deletedIds: deletedIds.slice(-MAX_DELETED),
      error: "",
    };
  } catch (error) {
    console.error("Could not load MILO notifications.", error);
    return {
      items: [],
      keptItems: [],
      deletedIds: [],
      error: "Saved notifications could not be loaded from this device.",
    };
  }
}

export function useNotifications() {
  const [initialStore] = useState(loadStore);
  const [items, setItems] = useState<Notification[]>(initialStore.items);
  const [keptItems, setKeptItems] = useState<Notification[]>(initialStore.keptItems);
  const [deletedIds, setDeletedIds] = useState<string[]>(initialStore.deletedIds);
  const [storageError, setStorageError] = useState(initialStore.error);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ items, keptItems, deletedIds }),
      );
      setStorageError("");
    } catch (error) {
      console.error("Could not save MILO notifications.", error);
      setStorageError("Notification changes could not be saved on this device.");
    }
  }, [items, keptItems, deletedIds]);

  const push = useCallback((raw: NonNullable<MiloEvent["notification"]>): Notification | null => {
    const notification: Notification = {
      id: raw.id ?? uid(),
      kind: raw.kind ?? "system",
      app: raw.app ?? "System",
      appId: raw.appId,
      title: raw.title ?? "Notification",
      body: raw.body ?? "",
      callDirection: raw.callDirection,
      ts: Date.now(),
      priority: raw.priority ?? "normal",
      read: false,
    };

    if (deletedIds.includes(notification.id)) return null;
    if (keptItems.some((item) => item.id === notification.id)) {
      setKeptItems((previous) => previous.map((item) => (
        item.id === notification.id
          ? { ...item, app: notification.app, appId: notification.appId,
              title: notification.title, body: notification.body,
              kind: notification.kind, callDirection: notification.callDirection,
              priority: notification.priority }
          : item
      )));
      return notification;
    }

    setItems((previous) => {
      const existing = previous.find((item) => item.id === notification.id);
      const updated = existing
        ? { ...notification, ts: existing.ts, read: existing.read }
        : notification;
      return [updated, ...previous.filter((item) => item.id !== notification.id)].slice(0, MAX);
    });
    return notification;
  }, [deletedIds, keptItems]);

  const markRead = useCallback((id: string) => {
    setItems((previous) => previous.map((item) => (
      item.id === id ? { ...item, read: true } : item
    )));
    setKeptItems((previous) => previous.map((item) => (
      item.id === id ? { ...item, read: true } : item
    )));
  }, []);

  const keep = useCallback((id: string) => {
    const notification = items.find((item) => item.id === id);
    if (!notification) return;
    setItems((previous) => previous.filter((item) => item.id !== id));
    setKeptItems((previous) => [
      { ...notification, read: true },
      ...previous.filter((item) => item.id !== id),
    ].slice(0, MAX));
  }, [items]);

  const remove = useCallback((id: string) => {
    setItems((previous) => previous.filter((item) => item.id !== id));
    setKeptItems((previous) => previous.filter((item) => item.id !== id));
    setDeletedIds((previous) => [...new Set([...previous, id])].slice(-MAX_DELETED));
  }, []);

  const restore = useCallback((id: string) => {
    const notification = keptItems.find((item) => item.id === id);
    if (!notification) return;
    setKeptItems((previous) => previous.filter((item) => item.id !== id));
    setItems((previous) => [
      { ...notification, read: false },
      ...previous.filter((item) => item.id !== id),
    ].slice(0, MAX));
  }, [keptItems]);

  const clearAll = useCallback(() => {
    const ids = [...items, ...keptItems].map((item) => item.id);
    setItems([]);
    setKeptItems([]);
    setDeletedIds((previous) => [...new Set([...previous, ...ids])].slice(-MAX_DELETED));
  }, [items, keptItems]);

  const unread = useMemo(() => items.filter((item) => !item.read).length, [items]);

  return {
    items, keptItems, unread, storageError, push, markRead, keep, remove, restore, clearAll,
  };
}
