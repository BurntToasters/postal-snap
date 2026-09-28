//! QRESYNC (RFC 7162) VANISHED handling for CONDSTORE flag sync.
//!
//! Failure modes this module must survive:
//! - a huge VANISHED range (e.g. `1:4000000000`) must never be expanded;
//! - UID 0 and inverted ranges are ignored, never applied;
//! - 100+ queued unsolicited responses mean async-imap may have dropped
//!   ours (bounded channel), so the result cannot be trusted;
//! - VANISHED-less servers or failed ENABLE keep the legacy reconcile path;
//! - an overflowing or untrusted VANISHED falls back to `reconcile_expunges`;
//! - unrelated unsolicited lines (EXISTS, FLAGS) are ignored, not errors.

use std::ops::RangeInclusive;

use async_imap::types::UnsolicitedResponse;
use imap_proto::Response;

use super::ImapSession;

/// Most VANISHED UIDs applied at once; beyond this the full reconcile runs.
pub(super) const MAX_VANISHED_UIDS: u64 = 10_000;

/// async-imap's unsolicited channel holds this many items, then drops.
pub(super) const UNSOLICITED_CAPACITY: usize = 100;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum VanishedPlan {
    /// Expunged UIDs to remove locally.
    Apply(Vec<u32>),
    /// Too large or untrusted; run `reconcile_expunges` instead.
    Fallback,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ExpungePath {
    Reconcile,
    Skip,
}

/// Ranges from a VANISHED line, or None for any other response.
pub(super) fn vanished_ranges(response: &Response<'_>) -> Option<Vec<RangeInclusive<u32>>> {
    match response {
        Response::Vanished { uids, .. } => Some(uids.clone()),
        _ => None,
    }
}

/// Decide what to remove from the ranges, without expanding oversized ones.
pub(super) fn plan_vanished(ranges: &[RangeInclusive<u32>], drained: usize) -> VanishedPlan {
    if drained >= UNSOLICITED_CAPACITY {
        return VanishedPlan::Fallback;
    }
    let total = ranges.iter().fold(0u64, |sum, range| {
        let size = if range.start() > range.end() {
            0
        } else {
            u64::from(*range.end()) - u64::from(*range.start()) + 1
        };
        sum.saturating_add(size)
    });
    if total > MAX_VANISHED_UIDS {
        return VanishedPlan::Fallback;
    }
    let uids = ranges
        .iter()
        .flat_map(|range| range.clone())
        .filter(|uid| *uid != 0)
        .collect();
    VanishedPlan::Apply(uids)
}

pub(super) fn decide_expunge_path(
    plan: Option<&VanishedPlan>,
    expunge_suspected: bool,
) -> ExpungePath {
    match plan {
        Some(VanishedPlan::Apply(_)) => ExpungePath::Skip,
        Some(VanishedPlan::Fallback) => ExpungePath::Reconcile,
        None if expunge_suspected => ExpungePath::Reconcile,
        None => ExpungePath::Skip,
    }
}

/// Take every queued unsolicited response: VANISHED ranges plus the count.
pub(super) fn drain_vanished(session: &mut ImapSession) -> (Vec<RangeInclusive<u32>>, usize) {
    let mut ranges = Vec::new();
    let mut count = 0usize;
    while let Ok(item) = session.unsolicited_responses.try_recv() {
        count += 1;
        if let UnsolicitedResponse::Other(data) = item {
            if let Some(found) = vanished_ranges(data.parsed()) {
                ranges.extend(found);
            }
        }
    }
    (ranges, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_small_ranges_and_skips_zero() {
        let plan = plan_vanished(&[0..=0, 3..=5, 9..=9], 1);
        assert_eq!(plan, VanishedPlan::Apply(vec![3, 4, 5, 9]));
    }

    #[test]
    fn ignores_inverted_ranges() {
        assert_eq!(
            plan_vanished(&[RangeInclusive::new(7, 2)], 0),
            VanishedPlan::Apply(Vec::new())
        );
    }

    #[test]
    fn huge_range_falls_back_without_expanding() {
        assert_eq!(plan_vanished(&[1..=u32::MAX], 1), VanishedPlan::Fallback);
        // Many ranges whose sum passes the cap.
        let many = (0..3u32)
            .map(|index| index * 10_000 + 1..=index * 10_000 + 6_000)
            .collect::<Vec<_>>();
        assert_eq!(plan_vanished(&many, 3), VanishedPlan::Fallback);
    }

    #[test]
    fn exactly_at_cap_applies() {
        let plan = plan_vanished(&[1..=MAX_VANISHED_UIDS as u32], 1);
        assert!(matches!(plan, VanishedPlan::Apply(uids) if uids.len() == 10_000));
    }

    #[test]
    fn full_unsolicited_channel_falls_back() {
        assert_eq!(
            plan_vanished(&[4..=4], UNSOLICITED_CAPACITY),
            VanishedPlan::Fallback
        );
        assert!(matches!(
            plan_vanished(&[4..=4], UNSOLICITED_CAPACITY - 1),
            VanishedPlan::Apply(_)
        ));
    }

    #[test]
    fn parses_earlier_and_plain_vanished_lines() {
        let (_, earlier) =
            imap_proto::parser::parse_response(b"* VANISHED (EARLIER) 300:302,405\r\n").unwrap();
        assert_eq!(vanished_ranges(&earlier), Some(vec![300..=302, 405..=405]));
        let (_, plain) = imap_proto::parser::parse_response(b"* VANISHED 7\r\n").unwrap();
        assert_eq!(vanished_ranges(&plain), Some(vec![7..=7]));
    }

    #[test]
    fn ignores_unrelated_lines() {
        let (_, exists) = imap_proto::parser::parse_response(b"* 12 EXISTS\r\n").unwrap();
        assert_eq!(vanished_ranges(&exists), None);
        let (_, expunge) = imap_proto::parser::parse_response(b"* 3 EXPUNGE\r\n").unwrap();
        assert_eq!(vanished_ranges(&expunge), None);
    }

    #[test]
    fn expunge_path_decision() {
        let apply = VanishedPlan::Apply(vec![1]);
        // Applied VANISHED replaces the UID SEARCH even if counts dropped.
        assert_eq!(decide_expunge_path(Some(&apply), true), ExpungePath::Skip);
        // Untrusted VANISHED always reconciles.
        assert_eq!(
            decide_expunge_path(Some(&VanishedPlan::Fallback), false),
            ExpungePath::Reconcile
        );
        // No QRESYNC: legacy behavior follows the count heuristic.
        assert_eq!(decide_expunge_path(None, true), ExpungePath::Reconcile);
        assert_eq!(decide_expunge_path(None, false), ExpungePath::Skip);
    }
}
