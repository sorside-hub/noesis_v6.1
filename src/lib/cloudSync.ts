import { supabase } from './supabase';
import { db } from './db';
import { FileNode } from '../types/vault';
import { RealtimeChannel } from '@supabase/supabase-js';
import { getUserId, toTimestamp } from './sync/syncHelpers';

export { syncPullFromCloud, syncPushAllToCloud } from './sync/syncOperations';
export type { SyncSummary } from './sync/syncOperations';

let syncChannel: RealtimeChannel | null = null;
const pushDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
let lastPushedGroupsJson = '';

// Initialize Supabase Realtime Subscription
export const initRealtimeSync = async () => {
  const userId = await getUserId();
  if (!userId) return;

  if (syncChannel) {
    supabase.removeChannel(syncChannel);
  }

  syncChannel = supabase
    .channel('public:sync')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'nodes', filter: `user_id=eq.${userId}` },
      async (payload) => {
        if (payload.eventType === 'DELETE') {
          if (payload.old?.id === '__system_bookmark_groups__') {
            await db.settings.delete('bookmarkGroups');
            localStorage.removeItem('noesis_vault_bookmark_groups');
            lastPushedGroupsJson = '[]';
            window.dispatchEvent(new CustomEvent('bookmark-groups-updated', { detail: [] }));
          } else {
            await db.nodes.delete(payload.old.id);
            window.dispatchEvent(new Event('vault-updated'));
          }
        } else if (payload.new) {
          const cloudNode = payload.new as any;

          // Special handling for System Bookmark Groups
          if (cloudNode.id === '__system_bookmark_groups__') {
            try {
              const groups = cloudNode.metadata?.groups || (cloudNode.content ? JSON.parse(cloudNode.content) : []);
              if (Array.isArray(groups)) {
                const groupsJson = JSON.stringify(groups);
                const currentLocal = localStorage.getItem('noesis_vault_bookmark_groups');
                // Guard against echo-loop: if cloud data is identical to local state or just pushed, ignore
                if (currentLocal === groupsJson || lastPushedGroupsJson === groupsJson) {
                  return;
                }
                lastPushedGroupsJson = groupsJson;
                await db.settings.put({ key: 'bookmarkGroups', value: groupsJson });
                localStorage.setItem('noesis_vault_bookmark_groups', groupsJson);
                window.dispatchEvent(new CustomEvent('bookmark-groups-updated', { detail: groups }));
              }
            } catch (e) {
              console.warn('Failed to parse realtime bookmark groups:', e);
            }
            return;
          }

          const cloudUpdatedAt = toTimestamp(cloudNode.updatedAt);
          const existingLocal = await db.nodes.get(cloudNode.id);

          // Ignore stale or local-echo events if local data is equal or newer
          if (existingLocal && existingLocal.updatedAt && existingLocal.updatedAt >= cloudUpdatedAt) {
            return;
          }

          const localNode: FileNode = {
            id: cloudNode.id,
            name: cloudNode.name,
            type: cloudNode.type as 'file' | 'folder',
            parentId: cloudNode.parentId,
            content: cloudNode.content || undefined,
            metadata: cloudNode.metadata || undefined,
            createdAt: toTimestamp(cloudNode.createdAt),
            updatedAt: cloudUpdatedAt,
          };
          await db.nodes.put(localNode);
          window.dispatchEvent(new Event('vault-updated'));
        }
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'chat_sessions', filter: `user_id=eq.${userId}` },
      async (payload) => {
        if (payload.eventType === 'DELETE') {
          await db.chat_sessions.delete(payload.old.id);
        } else if (payload.new) {
          await db.chat_sessions.put(payload.new as any);
        }
        window.dispatchEvent(new Event('chat-updated'));
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'chat_messages', filter: `user_id=eq.${userId}` },
      async (payload) => {
        if (payload.eventType === 'DELETE') {
          await db.chat_messages.delete(payload.old.id);
        } else if (payload.new) {
          const existing = await db.chat_messages.get(payload.new.id);
          const toPut = {
            ...payload.new,
            cascadeLog: existing?.cascadeLog,
          };
          await db.chat_messages.put(toPut as any);
        }
        window.dispatchEvent(new Event('chat-updated'));
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'media_attachments', filter: `user_id=eq.${userId}` },
      async (payload) => {
        if (payload.eventType === 'DELETE') {
          await db.media_attachments.delete(payload.old.id);
        } else if (payload.new) {
          // Parse back to local format if needed
          const record = payload.new;
          const existingLocal = await db.media_attachments.get(record.id);
          let deletedAt = record.deleted_at ? new Date(record.deleted_at).getTime() : undefined;
          if (!deletedAt && existingLocal?.deletedAt) {
            deletedAt = existingLocal.deletedAt;
          }

          const localItem = {
            id: record.id,
            title: record.title,
            url: record.url,
            type: record.type,
            createdAt: record.created_at || new Date().toISOString(),
            deletedAt
          };
          
          await db.media_attachments.put(localItem as any);
        }
        // Assuming we need a way to notify media view of updates
        window.dispatchEvent(new Event('media-updated'));
      }
    )
    .subscribe();
};

// Push a single node (create or update) to Supabase (debounced to avoid network thrashing during fast typing)
export const pushNodeToCloud = async (node: FileNode): Promise<void> => {
  const nodeId = node.id;
  if (pushDebounceTimers.has(nodeId)) {
    clearTimeout(pushDebounceTimers.get(nodeId)!);
  }

  const timer = setTimeout(async () => {
    pushDebounceTimers.delete(nodeId);
    try {
      const userId = await getUserId();
      if (!userId) return; // Not logged in, skip sync

      // Always fetch the freshest node from IndexedDB right before sending to Supabase
      // to ensure both fast-typing content and bookmark metadata updates are preserved
      const freshNode = (await db.nodes.get(nodeId)) || node;

      const payload = {
        id: freshNode.id,
        name: freshNode.name,
        type: freshNode.type,
        parentId: freshNode.parentId,
        content: freshNode.content || null,
        metadata: freshNode.metadata || null,
        createdAt: freshNode.createdAt,
        updatedAt: freshNode.updatedAt,
        user_id: userId,
      };

      const { error } = await supabase.from('nodes').upsert(payload);
      if (error) {
        console.warn('Supabase push failed (possibly offline or invalid config):', error.message);
      }
    } catch (err) {
      console.warn('Failed to push to cloud:', err);
    }
  }, 500);

  pushDebounceTimers.set(nodeId, timer);
};

// Delete nodes and their associated AI metadata and embeddings from Supabase
export const deleteNodesFromCloud = async (ids: string[]): Promise<void> => {
  if (!ids || ids.length === 0) return;
  try {
    const userId = await getUserId();
    if (!userId) return; // Not logged in, skip sync

    // 1. Delete associated AI analysis metadata
    await supabase
      .from('note_metadata')
      .delete()
      .in('note_id', ids)
      .eq('user_id', userId);

    // 2. Delete associated RAG vector embeddings
    await supabase
      .from('note_embeddings')
      .delete()
      .in('note_id', ids)
      .eq('user_id', userId);

    // 3. Delete nodes themselves (will also trigger ON DELETE CASCADE in DB)
    const { error } = await supabase
      .from('nodes')
      .delete()
      .in('id', ids)
      .eq('user_id', userId);

    if (error) {
      console.warn('Supabase delete error:', error.message);
    }
  } catch (err) {
    console.warn('Failed to delete from cloud:', err);
  }
};

// Push a single chat session to Supabase
export const pushChatSessionToCloud = async (session: any): Promise<void> => {
  try {
    const userId = await getUserId();
    if (!userId) return;

    const cloudSession = {
      id: session.id,
      title: session.title || 'Untitled Chat',
      isPinned: Boolean(session.isPinned),
      memorySummary: session.memorySummary || null,
      createdAt: toTimestamp(session.createdAt),
      updatedAt: toTimestamp(session.updatedAt),
      user_id: userId,
    };

    const { error } = await supabase.from('chat_sessions').upsert(cloudSession);
    if (error) console.warn('Supabase chat session push error:', error.message);
  } catch (err) {
    console.warn('Failed to push chat session to cloud:', err);
  }
};

// Push a single chat message to Supabase
export const pushChatMessageToCloud = async (msg: any): Promise<void> => {
  try {
    const userId = await getUserId();
    if (!userId) return;

    const cloudMsg = {
      id: msg.id,
      sessionId: msg.sessionId,
      role: msg.role,
      content: msg.content || '',
      sources: msg.sources || null,
      chunks: msg.chunks || null,
      createdAt: toTimestamp(msg.createdAt),
      user_id: userId,
    };

    const { error } = await supabase.from('chat_messages').upsert(cloudMsg);
    if (error) console.warn('Supabase chat message push error:', error.message);
  } catch (err) {
    console.warn('Failed to push chat message to cloud:', err);
  }
};

// Delete a chat session from Supabase (will cascade messages)
export const deleteChatSessionFromCloud = async (id: string): Promise<void> => {
  try {
    const userId = await getUserId();
    if (!userId) return;

    const { error } = await supabase
      .from('chat_sessions')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    if (error) console.warn('Supabase chat session delete error:', error.message);
  } catch (err) {
    console.warn('Failed to delete chat session from cloud:', err);
  }
};

// Delete chat messages from Supabase
export const deleteChatMessagesFromCloud = async (ids: string[]): Promise<void> => {
  try {
    const userId = await getUserId();
    if (!userId || ids.length === 0) return;

    const { error } = await supabase
      .from('chat_messages')
      .delete()
      .in('id', ids)
      .eq('user_id', userId);
    if (error) console.warn('Supabase chat message delete error:', error.message);
  } catch (err) {
    console.warn('Failed to delete chat messages from cloud:', err);
  }
};

let groupsDebounceTimer: NodeJS.Timeout | null = null;

// Push Bookmark Groups to Supabase (debounced)
export const pushBookmarkGroupsToCloud = async (groups: any[]): Promise<void> => {
  if (groupsDebounceTimer) {
    clearTimeout(groupsDebounceTimer);
  }

  groupsDebounceTimer = setTimeout(async () => {
    groupsDebounceTimer = null;
    try {
      const userId = await getUserId();
      if (!userId) return;

      const groupsJson = JSON.stringify(groups || []);
      // Skip if identical to what was already pushed or received
      if (groupsJson === lastPushedGroupsJson) {
        return;
      }
      lastPushedGroupsJson = groupsJson;

      const payload = {
        id: '__system_bookmark_groups__',
        name: 'Bookmark Groups',
        type: 'system',
        parentId: '__system__',
        content: groupsJson,
        metadata: { groups: groups || [] },
        createdAt: 0,
        updatedAt: Date.now(),
        user_id: userId,
      };

      const { error } = await supabase.from('nodes').upsert(payload);
      if (error) {
        console.warn('Supabase bookmark groups push error:', error.message);
      }
    } catch (err) {
      console.warn('Failed to push bookmark groups to cloud:', err);
    }
  }, 400);
};
