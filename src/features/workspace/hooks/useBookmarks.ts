import { useState, useEffect, useCallback, useMemo } from 'react';
import { BookmarkItem, BookmarkGroup, BookmarksState } from '../types/bookmarks';
import { VaultData, FileNode, BookmarkMeta } from '../../../types/vault';
import { db } from '../../../lib/db';
import { pushBookmarkGroupsToCloud } from '../../../lib/cloudSync';

const STORAGE_KEY_GROUPS = 'noesis_vault_bookmark_groups';

interface UseBookmarksProps {
  vault: VaultData | null;
  setNodeBookmark?: (nodeId: string, bookmark: BookmarkMeta | null) => void;
}

export function useBookmarks(
  vault: VaultData | null,
  setNodeBookmark?: (nodeId: string, bookmark: BookmarkMeta | null) => void
) {
  // Bookmark Groups state
  const [groups, setGroups] = useState<BookmarkGroup[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_GROUPS);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[useBookmarks] Error loading bookmark groups from localStorage:', e);
    }
    return [];
  });

  // Load groups from IndexedDB settings on mount and listen to cross-device / sync events
  useEffect(() => {
    db.settings
      .get('bookmarkGroups')
      .then((setting) => {
        if (setting?.value) {
          try {
            const parsed = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
            if (Array.isArray(parsed)) {
              setGroups(parsed);
              localStorage.setItem(STORAGE_KEY_GROUPS, JSON.stringify(parsed));
            }
          } catch (e) {
            console.warn('[useBookmarks] Error parsing bookmarkGroups from DB:', e);
          }
        }
      })
      .catch((e) => {
        console.warn('[useBookmarks] Failed to load bookmarkGroups from IndexedDB:', e);
      });

    // Handle remote realtime sync updates or full pull sync updates
    const handleGroupsUpdated = (e: any) => {
      if (e.detail && Array.isArray(e.detail)) {
        setGroups(e.detail);
      } else {
        db.settings.get('bookmarkGroups').then((setting) => {
          if (setting?.value) {
            const parsed = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
            if (Array.isArray(parsed)) {
              setGroups(parsed);
            }
          }
        });
      }
    };

    window.addEventListener('bookmark-groups-updated', handleGroupsUpdated);
    return () => window.removeEventListener('bookmark-groups-updated', handleGroupsUpdated);
  }, []);

  // Save groups to IndexedDB, localStorage, and Supabase Cloud when changed
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_GROUPS, JSON.stringify(groups));
      db.settings
        .put({ key: 'bookmarkGroups', value: JSON.stringify(groups) })
        .catch((err) => console.warn('[useBookmarks] Error saving groups to IndexedDB:', err));
      
      // Auto-sync bookmark groups to Supabase Cloud
      pushBookmarkGroupsToCloud(groups).catch((err) =>
        console.warn('[useBookmarks] Error pushing groups to Supabase:', err)
      );
    } catch (e) {
      console.warn('[useBookmarks] Error saving bookmark groups:', e);
    }
  }, [groups]);

  // Modal State for Obsidian-Style Bookmark Dialog
  const [isBookmarkModalOpen, setIsBookmarkModalOpen] = useState(false);
  const [modalTargetNode, setModalTargetNode] = useState<FileNode | null>(null);

  // Derive bookmarks list reactively from vault.nodes (100% real-time from vault state & IndexedDB/Supabase metadata)
  const bookmarks = useMemo<BookmarkItem[]>(() => {
    if (!vault || !vault.nodes) return [];

    const result: BookmarkItem[] = [];
    Object.values(vault.nodes).forEach((node) => {
      const bm = node.metadata?.bookmark;
      if (bm && bm.isBookmarked) {
        result.push({
          id: `bm_${node.id}`,
          nodeId: node.id,
          type: node.type,
          title: bm.title || node.name,
          groupId: bm.groupId || null,
          createdAt: bm.bookmarkedAt || node.updatedAt || Date.now(),
        });
      }
    });

    // Sort by creation time
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }, [vault]);

  // Check if a node is bookmarked
  const isBookmarked = useCallback(
    (nodeId: string): boolean => {
      if (!vault || !vault.nodes[nodeId]) return false;
      return !!vault.nodes[nodeId].metadata?.bookmark?.isBookmarked;
    },
    [vault]
  );

  // Get bookmark metadata for a node
  const getBookmarkMeta = useCallback(
    (nodeId: string): BookmarkMeta | undefined => {
      if (!vault || !vault.nodes[nodeId]) return undefined;
      return vault.nodes[nodeId].metadata?.bookmark;
    },
    [vault]
  );

  // Open Bookmark Modal for a specific node (Obsidian Style)
  const openBookmarkModal = useCallback(
    (nodeId: string) => {
      if (!vault || !vault.nodes[nodeId]) return;
      setModalTargetNode(vault.nodes[nodeId]);
      setIsBookmarkModalOpen(true);
    },
    [vault]
  );

  // Close Bookmark Modal
  const closeBookmarkModal = useCallback(() => {
    setIsBookmarkModalOpen(false);
    setModalTargetNode(null);
  }, []);

  // Save Bookmark (Sets metadata, writes to IndexedDB and pushes to Supabase)
  const saveBookmark = useCallback(
    (nodeId: string, customTitle?: string, targetGroupId?: string | null) => {
      if (!vault || !vault.nodes[nodeId]) return;
      const targetNode = vault.nodes[nodeId];

      const bookmarkPayload: BookmarkMeta = {
        isBookmarked: true,
        title: customTitle?.trim() || targetNode.name,
        groupId: targetGroupId || null,
        bookmarkedAt: targetNode.metadata?.bookmark?.bookmarkedAt || Date.now(),
      };

      if (setNodeBookmark) {
        setNodeBookmark(nodeId, bookmarkPayload);
      }
    },
    [vault, setNodeBookmark]
  );

  // Remove Bookmark (Removes metadata, updates IndexedDB and Supabase)
  const removeBookmark = useCallback(
    (nodeIdOrBookmarkId: string) => {
      if (!vault) return;
      // Handle either bookmark id (`bm_xxx`) or direct node id
      const nodeId = nodeIdOrBookmarkId.startsWith('bm_')
        ? nodeIdOrBookmarkId.replace(/^bm_/, '')
        : nodeIdOrBookmarkId;

      if (setNodeBookmark) {
        setNodeBookmark(nodeId, null);
      }
    },
    [vault, setNodeBookmark]
  );

  // Toggle bookmark directly or open modal
  const toggleBookmark = useCallback(
    (nodeId: string) => {
      openBookmarkModal(nodeId);
    },
    [openBookmarkModal]
  );

  // Update bookmark title or move to group
  const updateBookmark = useCallback(
    (bookmarkId: string, updates: Partial<Pick<BookmarkItem, 'title' | 'groupId'>>) => {
      const nodeId = bookmarkId.startsWith('bm_') ? bookmarkId.replace(/^bm_/, '') : bookmarkId;
      if (!vault || !vault.nodes[nodeId]) return;

      const node = vault.nodes[nodeId];
      const current = node.metadata?.bookmark;
      if (!current) return;

      const updatedPayload: BookmarkMeta = {
        ...current,
        title: updates.title !== undefined ? updates.title : current.title,
        groupId: updates.groupId !== undefined ? updates.groupId : current.groupId,
      };

      if (setNodeBookmark) {
        setNodeBookmark(nodeId, updatedPayload);
      }
    },
    [vault, setNodeBookmark]
  );

  // Create new Bookmark Group
  const createGroup = useCallback((name: string): string | undefined => {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    const newGroup: BookmarkGroup = {
      id: `bmg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      name: trimmed,
      createdAt: Date.now(),
      order: groups.length,
    };
    setGroups((prev) => [...prev, newGroup]);
    return newGroup.id;
  }, [groups]);

  // Rename Bookmark Group
  const renameGroup = useCallback((groupId: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g))
    );
  }, []);

  // Delete Bookmark Group (moves bookmarks in that group to root)
  const deleteGroup = useCallback(
    (groupId: string) => {
      setGroups((prev) => prev.filter((g) => g.id !== groupId));

      // Update any bookmarked node in this group to have groupId: null
      if (vault && setNodeBookmark) {
        Object.values(vault.nodes).forEach((node) => {
          if (node.metadata?.bookmark?.groupId === groupId) {
            setNodeBookmark(node.id, {
              ...node.metadata.bookmark,
              groupId: null,
            });
          }
        });
      }
    },
    [vault, setNodeBookmark]
  );

  return {
    bookmarks,
    groups,
    isBookmarked,
    getBookmarkMeta,
    openBookmarkModal,
    closeBookmarkModal,
    isBookmarkModalOpen,
    modalTargetNode,
    saveBookmark,
    toggleBookmark,
    removeBookmark,
    updateBookmark,
    createGroup,
    renameGroup,
    deleteGroup,
    totalBookmarksCount: bookmarks.length,
  };
}
