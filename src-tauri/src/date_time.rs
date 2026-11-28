use time::format_description::well_known::{Rfc2822, Rfc3339};
use time::format_description::StaticFormatDescription;
use time::{Date, OffsetDateTime, PrimitiveDateTime, UtcOffset};

const RFC3339_SECONDS: StaticFormatDescription = time::macros::format_description!(
    "[year]-[month]-[day]T[hour]:[minute]:[second][offset_hour sign:mandatory]:[offset_minute]"
);
const RFC3339_MILLIS: StaticFormatDescription =
    time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3][offset_hour sign:mandatory]:[offset_minute]");
const RFC3339_MICROS: StaticFormatDescription =
    time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:6][offset_hour sign:mandatory]:[offset_minute]");
const RFC3339_NANOS: StaticFormatDescription =
    time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:9][offset_hour sign:mandatory]:[offset_minute]");
const UTC_SECONDS: StaticFormatDescription =
    time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]+00:00");
const UTC_MILLIS_Z: StaticFormatDescription = time::macros::format_description!(
    "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
);
const COMPACT_UTC_SECONDS: StaticFormatDescription =
    time::macros::format_description!("[year][month][day][hour][minute][second]");
const RFC2822_OUTPUT: StaticFormatDescription = time::macros::format_description!(
    "[weekday repr:short], [day padding:none] [month repr:short] [year] [hour]:[minute]:[second] [offset_hour sign:mandatory][offset_minute]"
);
const ASCTIME_UTC: StaticFormatDescription = time::macros::format_description!(
    "[weekday repr:short] [month repr:short] [day padding:space] [hour]:[minute]:[second] [year]"
);
const ISO_DATE: StaticFormatDescription = time::macros::format_description!("[year]-[month]-[day]");
const ISO_DATE_TIME: StaticFormatDescription =
    time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]");
const ICS_DATE: StaticFormatDescription = time::macros::format_description!("[year][month][day]");
const ICS_DATE_TIME: StaticFormatDescription =
    time::macros::format_description!("[year][month][day]T[hour][minute][second]");

pub(crate) fn now_utc() -> OffsetDateTime {
    OffsetDateTime::now_utc()
}

pub(crate) fn now_local() -> OffsetDateTime {
    OffsetDateTime::now_local().unwrap_or_else(|_| now_utc())
}

pub(crate) fn parse_rfc3339(value: &str) -> Result<OffsetDateTime, time::error::Parse> {
    let mut normalized = value.to_string();
    if normalized.as_bytes().get(10) == Some(&b't') {
        normalized.replace_range(10..11, "T");
    }
    if normalized.ends_with('z') {
        normalized.pop();
        normalized.push('Z');
    }
    OffsetDateTime::parse(&normalized, &Rfc3339)
}

pub(crate) fn parse_rfc2822(value: &str) -> Result<OffsetDateTime, time::error::Parse> {
    OffsetDateTime::parse(value, &Rfc2822)
}

pub(crate) fn parse_iso_date(value: &str) -> Result<Date, time::error::Parse> {
    Date::parse(value, &ISO_DATE)
}

pub(crate) fn parse_ics_date(value: &str) -> Result<Date, time::error::Parse> {
    Date::parse(value, &ICS_DATE)
}

pub(crate) fn parse_ics_datetime(value: &str) -> Result<PrimitiveDateTime, time::error::Parse> {
    PrimitiveDateTime::parse(value, &ICS_DATE_TIME)
}

pub(crate) fn format_rfc3339(value: OffsetDateTime) -> String {
    let nanosecond = value.nanosecond();
    let description = if nanosecond == 0 {
        &RFC3339_SECONDS
    } else if nanosecond.is_multiple_of(1_000_000) {
        &RFC3339_MILLIS
    } else if nanosecond.is_multiple_of(1_000) {
        &RFC3339_MICROS
    } else {
        &RFC3339_NANOS
    };
    value
        .format(description)
        .expect("RFC 3339 supports the timestamp range used by Postal Snap")
}

pub(crate) fn format_utc_seconds(value: OffsetDateTime) -> String {
    let Some(utc) = value.checked_to_offset(UtcOffset::UTC) else {
        return value
            .format(&RFC3339_SECONDS)
            .expect("original RFC 3339 offset remains representable");
    };
    utc.format(&UTC_SECONDS)
        .expect("UTC timestamp supports the stored date range")
}

pub(crate) fn format_utc_millis_z(value: OffsetDateTime) -> String {
    match value.checked_to_offset(UtcOffset::UTC) {
        Some(utc) => utc
            .format(&UTC_MILLIS_Z)
            .expect("UTC timestamp supports the deferred move date range"),
        None => format_rfc3339(value),
    }
}

pub(crate) fn format_compact_utc_seconds(value: OffsetDateTime) -> String {
    let utc = value.checked_to_offset(UtcOffset::UTC).unwrap_or(value);
    utc.format(&COMPACT_UTC_SECONDS)
        .expect("UTC timestamp supports settings backup names")
}

pub(crate) fn format_rfc2822(value: OffsetDateTime) -> String {
    value
        .format(&RFC2822_OUTPUT)
        .expect("RFC 2822 supports the current mail timestamp")
}

pub(crate) fn format_asctime(value: OffsetDateTime) -> String {
    let utc = value.checked_to_offset(UtcOffset::UTC).unwrap_or(value);
    utc.format(&ASCTIME_UTC)
        .expect("asctime supports the current message timestamp")
}

pub(crate) fn format_iso_date(value: Date) -> String {
    value
        .format(&ISO_DATE)
        .expect("ISO date supports the search and calendar year range")
}

pub(crate) fn format_iso_datetime(value: PrimitiveDateTime) -> String {
    value
        .format(&ISO_DATE_TIME)
        .expect("ISO date-time supports the calendar year range")
}
