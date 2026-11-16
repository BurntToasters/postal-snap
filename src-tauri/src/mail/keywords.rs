//! Keyword-backed state: Apple flag-color bits and Junk training keywords.
//!
//! Pure helpers only. Callers decide from PERMANENTFLAGS whether keywords
//! may be written, and every store is best effort at the IMAP layer.

use async_imap::types::Flag;

/// Apple Mail stores a flag color as three keywords, one bit each.
pub(crate) const FLAG_BIT_KEYWORDS: [&str; 3] = ["$MailFlagBit0", "$MailFlagBit1", "$MailFlagBit2"];
pub(crate) const JUNK_KEYWORD: &str = "$Junk";
pub(crate) const NOT_JUNK_KEYWORD: &str = "$NotJunk";

/// A change to the flag color of a flagged message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ColorChange {
    /// Flag the message with this color (0 red through 6 gray).
    Set(u8),
    /// Remove the flag and every color bit.
    Clear,
}

/// Maps a color index to its bits. Only 0 through 6 are valid colors.
pub(crate) fn bits_for_color(color: u8) -> Option<u8> {
    (color <= 6).then_some(color)
}

/// Reads bits back as a color. Bits 7 read as red, like Apple Mail.
pub(crate) fn color_from_bits(bits: u8) -> u8 {
    match bits & 7 {
        7 => 0,
        other => other,
    }
}

/// Color of a flagged message from its keyword names. Unflagged is always 0.
pub(crate) fn color_from_keyword_names<'a>(names: impl IntoIterator<Item = &'a str>) -> u8 {
    let mut bits = 0u8;
    for name in names {
        for (index, bit_keyword) in FLAG_BIT_KEYWORDS.iter().enumerate() {
            if name.eq_ignore_ascii_case(bit_keyword) {
                bits |= 1 << index;
            }
        }
    }
    color_from_bits(bits)
}

/// A keyword is writable only when PERMANENTFLAGS has `\*` or lists it.
pub(crate) fn keyword_permitted(permanent: &[Flag<'_>], name: &str) -> bool {
    permanent.iter().any(|flag| match flag {
        Flag::MayCreate => true,
        Flag::Custom(existing) => existing.eq_ignore_ascii_case(name),
        _ => false,
    })
}

/// Recorded per mailbox at SELECT. Any keyword support counts for the UI.
pub(crate) fn keywords_allowed(permanent: &[Flag<'_>]) -> bool {
    permanent
        .iter()
        .any(|flag| matches!(flag, Flag::MayCreate | Flag::Custom(_)))
}

/// Color bits are written only when every bit keyword is writable.
pub(crate) fn color_bits_permitted(permanent: &[Flag<'_>]) -> bool {
    FLAG_BIT_KEYWORDS
        .iter()
        .all(|name| keyword_permitted(permanent, name))
}

/// The change a color update or un-star implies. Plain star-on has none.
pub(crate) fn color_change(
    is_starred: Option<bool>,
    flag_color: Option<u8>,
) -> Option<ColorChange> {
    match flag_color {
        Some(color) => Some(ColorChange::Set(color)),
        None if is_starred == Some(false) => Some(ColorChange::Clear),
        None => None,
    }
}

/// `STORE` value strings, in order, for one flag update.
///
/// Keyword bits are written only when `keywords` is true. Without them a
/// color change still updates `\Flagged`.
pub(crate) fn flag_store_commands(
    is_read: Option<bool>,
    is_starred: Option<bool>,
    color: Option<ColorChange>,
    keywords: bool,
) -> Vec<String> {
    let mut commands = Vec::new();
    if let Some(value) = is_read {
        commands.push(if value {
            "+FLAGS.SILENT (\\Seen)".to_string()
        } else {
            "-FLAGS.SILENT (\\Seen)".to_string()
        });
    }
    let starred = match color {
        Some(ColorChange::Set(_)) => Some(true),
        Some(ColorChange::Clear) => Some(false),
        None => is_starred,
    };
    if let Some(value) = starred {
        commands.push(if value {
            "+FLAGS.SILENT (\\Flagged)".to_string()
        } else {
            "-FLAGS.SILENT (\\Flagged)".to_string()
        });
    }
    let Some(change) = color.filter(|_| keywords) else {
        return commands;
    };
    commands.push(format!("-FLAGS.SILENT ({})", FLAG_BIT_KEYWORDS.join(" ")));
    if let ColorChange::Set(color) = change {
        if let Some(bits) = bits_for_color(color).filter(|bits| *bits != 0) {
            let names: Vec<&str> = FLAG_BIT_KEYWORDS
                .iter()
                .enumerate()
                .filter(|(index, _)| bits & (1 << index) != 0)
                .map(|(_, name)| *name)
                .collect();
            commands.push(format!("+FLAGS.SILENT ({})", names.join(" ")));
        }
    }
    commands
}

/// Junk training `STORE` for the source copy, or none when keywords are
/// not writable. Moving into junk adds `$Junk`; out of junk adds `$NotJunk`.
pub(crate) fn junk_store_commands(to_junk: bool, keywords: bool) -> Vec<String> {
    if !keywords {
        return Vec::new();
    }
    let (add, remove) = if to_junk {
        (JUNK_KEYWORD, NOT_JUNK_KEYWORD)
    } else {
        (NOT_JUNK_KEYWORD, JUNK_KEYWORD)
    };
    vec![
        format!("+FLAGS.SILENT ({add})"),
        format!("-FLAGS.SILENT ({remove})"),
    ]
}

/// `(uid set, command)` pairs for a junk STORE over a group of UIDs.
pub(crate) fn junk_store_plan(
    uids: &[u32],
    to_junk: bool,
    keywords: bool,
) -> Vec<(String, String)> {
    let set = uids
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",");
    junk_store_commands(to_junk, keywords)
        .into_iter()
        .map(|command| (set.clone(), command))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom(name: &str) -> Flag<'static> {
        Flag::Custom(name.to_string().into())
    }

    #[test]
    fn bits_round_trip_every_color_and_seven_reads_as_red() {
        for color in 0..=6u8 {
            let bits = bits_for_color(color).unwrap();
            assert_eq!(color_from_bits(bits), color);
        }
        assert_eq!(color_from_bits(7), 0);
        assert_eq!(
            color_from_keyword_names(["$mailflagbit0", "$MailFlagBit2"]),
            5
        );
        assert_eq!(color_from_keyword_names(["$Forwarded", "$Junk"]), 0);
    }

    #[test]
    fn unknown_color_values_are_refused() {
        assert_eq!(bits_for_color(7), None);
        assert_eq!(bits_for_color(255), None);
    }

    #[test]
    fn unpermitted_keywords_store_only_flagged() {
        let commands = flag_store_commands(None, None, Some(ColorChange::Set(3)), false);
        assert_eq!(commands, vec!["+FLAGS.SILENT (\\Flagged)".to_string()]);
        let cleared = flag_store_commands(None, None, Some(ColorChange::Clear), false);
        assert_eq!(cleared, vec!["-FLAGS.SILENT (\\Flagged)".to_string()]);
    }

    #[test]
    fn set_color_clears_all_bits_then_adds_the_chosen_ones() {
        let commands = flag_store_commands(None, None, Some(ColorChange::Set(3)), true);
        assert_eq!(
            commands,
            vec![
                "+FLAGS.SILENT (\\Flagged)".to_string(),
                "-FLAGS.SILENT ($MailFlagBit0 $MailFlagBit1 $MailFlagBit2)".to_string(),
                "+FLAGS.SILENT ($MailFlagBit0 $MailFlagBit1)".to_string(),
            ]
        );
        let red = flag_store_commands(None, None, Some(ColorChange::Set(0)), true);
        assert_eq!(red.len(), 2, "red adds no bits");
    }

    #[test]
    fn clear_removes_flagged_and_every_bit() {
        let plain = flag_store_commands(None, Some(false), None, true);
        assert_eq!(plain, vec!["-FLAGS.SILENT (\\Flagged)".to_string()]);
        let cleared = flag_store_commands(None, None, Some(ColorChange::Clear), true);
        assert_eq!(
            cleared,
            vec![
                "-FLAGS.SILENT (\\Flagged)".to_string(),
                "-FLAGS.SILENT ($MailFlagBit0 $MailFlagBit1 $MailFlagBit2)".to_string(),
            ]
        );
    }

    #[test]
    fn keyword_permission_accepts_star_or_exact_name_only() {
        assert!(keyword_permitted(&[Flag::MayCreate], "$MailFlagBit0"));
        assert!(keyword_permitted(
            &[custom("$mailflagbit0")],
            "$MailFlagBit0"
        ));
        assert!(!keyword_permitted(&[custom("$Junk")], "$MailFlagBit0"));
        assert!(!keyword_permitted(&[Flag::Seen], "$MailFlagBit0"));
        assert!(!color_bits_permitted(&[custom("$MailFlagBit0")]));
        assert!(color_bits_permitted(&[
            custom("$MailFlagBit0"),
            custom("$MailFlagBit1"),
            custom("$MailFlagBit2"),
        ]));
    }

    #[test]
    fn color_change_follows_flag_color_then_unstar() {
        assert_eq!(color_change(None, Some(2)), Some(ColorChange::Set(2)));
        assert_eq!(color_change(Some(false), None), Some(ColorChange::Clear));
        assert_eq!(color_change(Some(true), None), None);
        assert_eq!(color_change(None, None), None);
    }

    #[test]
    fn bulk_junk_moves_store_every_uid_in_the_group_before_the_move() {
        let plan = junk_store_plan(&[4, 9, 12], true, true);
        assert_eq!(plan.len(), 2);
        assert!(plan.iter().all(|(set, _)| set == "4,9,12"));
        assert_eq!(plan[0].1, "+FLAGS.SILENT ($Junk)");
        assert_eq!(plan[1].1, "-FLAGS.SILENT ($NotJunk)");
        let out = junk_store_plan(&[4, 9], false, true);
        assert_eq!(out[0].1, "+FLAGS.SILENT ($NotJunk)");
        assert!(junk_store_plan(&[4, 9], true, false).is_empty());
    }

    #[test]
    fn junk_training_is_sent_only_when_keywords_are_writable() {
        assert!(junk_store_commands(true, false).is_empty());
        assert_eq!(
            junk_store_commands(true, true),
            vec![
                "+FLAGS.SILENT ($Junk)".to_string(),
                "-FLAGS.SILENT ($NotJunk)".to_string(),
            ]
        );
        assert_eq!(
            junk_store_commands(false, true),
            vec![
                "+FLAGS.SILENT ($NotJunk)".to_string(),
                "-FLAGS.SILENT ($Junk)".to_string(),
            ]
        );
    }
}
