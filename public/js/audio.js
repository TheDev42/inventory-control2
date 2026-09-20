/*
 * One distinct tone per scan outcome (Web Audio, no files needed).
 *   out ......... rising two-note chime        return ...... falling two-note chime
 *   store ....... three quick rising notes     found ....... four-note fanfare (lost item recovered)
 *   pat_pass .... bright double "ding"         pat_fail .... low falling saw
 *   lookup ...... single blip                  warn ........ two flat beeps (duplicate / already done)
 *   error ....... long low buzz (blocked)      unknown ..... three descending blips (barcode not in system)
 *   out_warn .... "out" chime + low beep (went out, but PAT overdue / never tested)
 */
import { store } from './util.js';

let ctx = null;
let muted = store.get('muted', false);
let volume = store.get('volume', 0.8);

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function note(freq, start, dur, { type = 'sine', gain = 0.28 } = {}) {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + start;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * volume), t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

const tri = { type: 'triangle' };
export const TONES = {
  lookup: { label: 'Lookup / selected', play: () => note(880, 0, 0.09) },
  out: { label: 'Scanned OUT to rental', play: () => { note(523.25, 0, 0.12, tri); note(783.99, 0.11, 0.2, tri); } },
  out_warn: { label: 'Out, but PAT needs attention', play: () => { note(523.25, 0, 0.12, tri); note(783.99, 0.11, 0.16, tri); note(196, 0.34, 0.22, { type: 'square', gain: 0.12 }); } },
  return: { label: 'Returned to stock', play: () => { note(783.99, 0, 0.12, tri); note(523.25, 0.11, 0.2, tri); } },
  store: { label: 'Stored in container', play: () => { note(392, 0, 0.08); note(493.88, 0.08, 0.08); note(587.33, 0.16, 0.16); } },
  found: { label: 'Lost / disassembled item recovered', play: () => { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(f, i * 0.08, i === 3 ? 0.3 : 0.1, tri)); } },
  pat_pass: { label: 'PAT pass', play: () => { note(1318.5, 0, 0.3); note(1760, 0.13, 0.42); } },
  pat_fail: { label: 'PAT fail', play: () => { note(330, 0, 0.22, { type: 'sawtooth', gain: 0.16 }); note(233, 0.2, 0.42, { type: 'sawtooth', gain: 0.16 }); } },
  warn: { label: 'Duplicate / already done', play: () => { note(440, 0, 0.09, { type: 'square', gain: 0.1 }); note(440, 0.15, 0.09, { type: 'square', gain: 0.1 }); } },
  error: { label: 'Blocked / error', play: () => note(140, 0, 0.42, { type: 'sawtooth', gain: 0.2 }) },
  unknown: { label: 'Barcode not in system', play: () => { note(420, 0, 0.11, { type: 'square', gain: 0.1 }); note(315, 0.13, 0.11, { type: 'square', gain: 0.1 }); note(210, 0.26, 0.2, { type: 'square', gain: 0.1 }); } },
};

export function play(name, force = false) {
  if (muted && !force) return;
  try { (TONES[name] || TONES.lookup).play(); } catch { /* audio unavailable */ }
}
export const isMuted = () => muted;
export function setMuted(v) { muted = !!v; store.set('muted', muted); }
export const getVolume = () => volume;
export function setVolume(v) { volume = Math.min(1, Math.max(0.05, v)); store.set('volume', volume); }
// Browsers only allow audio after a user gesture; scanner keystrokes count, so this "unlocks" on the first key/click.
export const unlockAudio = () => { audio(); };
