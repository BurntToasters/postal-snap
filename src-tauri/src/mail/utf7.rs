use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};

/// Encode a mailbox name for IMAP4rev1 commands.
pub(crate) fn encode(name: &str) -> String {
    let mut output = String::with_capacity(name.len());
    let mut encoded = Vec::new();
    let flush = |output: &mut String, encoded: &mut Vec<u16>| {
        if encoded.is_empty() {
            return;
        }
        let mut bytes = Vec::with_capacity(encoded.len() * 2);
        for unit in encoded.drain(..) {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        output.push('&');
        output.push_str(&STANDARD_NO_PAD.encode(bytes).replace('/', ","));
        output.push('-');
    };

    for character in name.chars() {
        if character == '&' {
            flush(&mut output, &mut encoded);
            output.push_str("&-");
        } else if (' '..='~').contains(&character) {
            flush(&mut output, &mut encoded);
            output.push(character);
        } else {
            let mut units = [0u16; 2];
            encoded.extend_from_slice(character.encode_utf16(&mut units));
        }
    }
    flush(&mut output, &mut encoded);
    output
}

/// Decode a mailbox name returned by an IMAP4rev1 server.
pub(crate) fn decode(name: &str) -> String {
    let mut output = String::with_capacity(name.len());
    let mut remaining = name;
    while let Some(start) = remaining.find('&') {
        output.push_str(&remaining[..start]);
        let encoded_start = &remaining[start + 1..];
        let Some(end) = encoded_start.find('-') else {
            output.push_str(&remaining[start..]);
            return output;
        };
        let encoded = &encoded_start[..end];
        if encoded.is_empty() {
            output.push('&');
        } else {
            let base64 = encoded.replace(',', "/");
            let padding = (4 - base64.len() % 4) % 4;
            let padded = format!("{base64}{}", "=".repeat(padding));
            let Ok(bytes) = STANDARD_NO_PAD
                .decode(padded.trim_end_matches('='))
                .or_else(|_| base64::engine::general_purpose::STANDARD.decode(padded.as_bytes()))
            else {
                output.push_str(&remaining[start..start + end + 2]);
                remaining = &encoded_start[end + 1..];
                continue;
            };
            if bytes.len() % 2 != 0 {
                output.push_str(&remaining[start..start + end + 2]);
            } else {
                let units = bytes
                    .chunks_exact(2)
                    .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                    .collect::<Vec<_>>();
                if let Ok(decoded) = String::from_utf16(&units) {
                    output.push_str(&decoded);
                } else {
                    output.push_str(&remaining[start..start + end + 2]);
                }
            }
        }
        remaining = &encoded_start[end + 1..];
    }
    output.push_str(remaining);
    output
}
