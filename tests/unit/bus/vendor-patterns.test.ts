import { describe, expect, it } from 'vitest';
import {
  VENDOR_DOC_PATTERNS,
  listVendorDocPatterns,
  vendorDocPattern,
} from '../../../src/bus/vendor-patterns';

describe('vendor-patterns', () => {
  it('listVendorDocPatterns returns all 3 patterns', () => {
    expect(listVendorDocPatterns()).toEqual(VENDOR_DOC_PATTERNS);
    expect(listVendorDocPatterns()).toHaveLength(3);
  });

  it('looks up each vendor by exact canonical name', () => {
    expect(vendorDocPattern('Example Plumbing')?.vendor_name).toBe('Example Plumbing');
    expect(vendorDocPattern('Example Services')?.vendor_name).toBe('Example Services');
    expect(vendorDocPattern('In-House Tech')?.vendor_name).toBe('In-House Tech');
  });

  it('looks up aliases case-insensitively', () => {
    expect(vendorDocPattern('EXAMPLE PLUMBER')?.vendor_name).toBe('Example Plumbing');
    expect(vendorDocPattern('ExAmPlE VeNdOr')?.vendor_name).toBe('Example Services');
    expect(vendorDocPattern('maintenance technician')?.vendor_name).toBe('In-House Tech');
  });

  it('returns null for an unknown vendor', () => {
    expect(vendorDocPattern('nonexistent vendor')).toBeNull();
  });

  it('returns null for null, undefined, and empty input', () => {
    expect(vendorDocPattern(null)).toBeNull();
    expect(vendorDocPattern(undefined)).toBeNull();
    expect(vendorDocPattern('')).toBeNull();
  });

  it('stores closeout_lag_minutes as a number for every pattern', () => {
    for (const pattern of VENDOR_DOC_PATTERNS) {
      expect(typeof pattern.closeout_lag_minutes).toBe('number');
    }
  });

  it('uses only valid DocSource members for photos and notes', () => {
    const validSources = new Set(['in-pm', 'off-system', 'late', 'manager-backfill']);

    for (const pattern of VENDOR_DOC_PATTERNS) {
      expect(validSources.has(pattern.photos)).toBe(true);
      expect(validSources.has(pattern.notes)).toBe(true);
    }
  });
});
