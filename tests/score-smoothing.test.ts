import { describe, it, expect } from 'vitest';
import { smoothScore, smoothScoreFromRaw } from '../src/lib/candidate/score-smoothing';

describe('smoothScore — reproduces the 8vance platform table exactly', () => {
  it('hits the transcribed table rows (rounded)', () => {
    expect(smoothScore(30)).toBe(40);
    expect(smoothScore(45)).toBe(60);
    expect(smoothScore(50)).toBe(67); // 66.7 → 67
    expect(smoothScore(60)).toBe(80);
    expect(smoothScore(62)).toBe(81);
    expect(smoothScore(65)).toBe(83); // 82.5 → 83 (round half up)
    expect(smoothScore(66)).toBe(83);
    expect(smoothScore(80)).toBe(90);
    expect(smoothScore(90)).toBe(91);
  });
  it('compresses the very top: raw 100 shows only 92', () => {
    expect(smoothScore(100)).toBe(92);
    expect(smoothScore(0)).toBe(0);
  });
  it('is monotonic non-decreasing', () => {
    let prev = -1;
    for (let r = 0; r <= 100; r += 1) {
      const s = smoothScore(r);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
  it('pushes the mid-range UP (60 raw shows 80, not 60)', () => {
    expect(smoothScore(60)).toBe(80);
    expect(smoothScore(50)).toBeGreaterThan(50);
  });
  it('clamps out-of-range input', () => {
    expect(smoothScore(-10)).toBe(0);
    expect(smoothScore(150)).toBe(92);
    expect(smoothScore(Number.NaN)).toBe(0);
  });
});

describe('smoothScoreFromRaw — accepts 0..1 or 0..100', () => {
  it('treats <=1 as a fraction', () => {
    expect(smoothScoreFromRaw(0.66)).toBe(smoothScore(66));
    expect(smoothScoreFromRaw(0.6)).toBe(80);
  });
  it('treats >1 as an already-percent value', () => {
    expect(smoothScoreFromRaw(66)).toBe(83);
  });
});
