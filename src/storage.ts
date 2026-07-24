// Per-league persistence over chrome.storage.local. Rankings and the Par
// Sheet are stored separately so you can keep distinct sheets per league and
// swap without a rebuild.

import type { ParSheet, Player, Tier } from "./types.js";

const LEAGUES_KEY = "leagues";
const CURRENT_LEAGUE_KEY = "currentLeague";
const DEFAULT_LEAGUES = ["League 1", "League 2"];

export interface RankingsData {
  players: Player[];
  tiers: Tier[];
  meta: { source?: string; importedAt: number };
}

const parKey = (league: string): string => `parSheet:${league}`;
const rankingsKey = (league: string): string => `rankings:${league}`;

async function read<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function write(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function getLeagues(): Promise<string[]> {
  const stored = await read<string[]>(LEAGUES_KEY);
  return Array.isArray(stored) && stored.length > 0 ? stored : DEFAULT_LEAGUES;
}

export async function getCurrentLeague(): Promise<string> {
  const stored = await read<string>(CURRENT_LEAGUE_KEY);
  return stored ?? DEFAULT_LEAGUES[0] ?? "League 1";
}

export async function setCurrentLeague(league: string): Promise<void> {
  await write(CURRENT_LEAGUE_KEY, league);
}

export async function loadParSheet(league: string): Promise<ParSheet | undefined> {
  return read<ParSheet>(parKey(league));
}

export async function saveParSheet(league: string, sheet: ParSheet): Promise<void> {
  await write(parKey(league), sheet);
}

export async function loadRankings(league: string): Promise<RankingsData | undefined> {
  return read<RankingsData>(rankingsKey(league));
}

export async function saveRankings(league: string, data: RankingsData): Promise<void> {
  await write(rankingsKey(league), data);
}
