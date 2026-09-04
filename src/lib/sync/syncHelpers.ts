import { supabase, getSupabaseConfig } from '../supabase';

// Get current user ID silently
export const getUserId = async (): Promise<string | null> => {
  if (!getSupabaseConfig().isConfigured) return null;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.user?.id || null;
  } catch (err) {
    return null;
  }
};

// Helper to safely convert to ISO string
export const toIsoString = (val: any) => {
  if (typeof val === 'number') return new Date(val).toISOString();
  if (val instanceof Date) return val.toISOString();
  return val;
};

// Helper to safely convert to timestamp number
export const toTimestamp = (val: any) => {
  if (typeof val === 'string') return new Date(val).getTime();
  if (val instanceof Date) return val.getTime();
  return val;
};
