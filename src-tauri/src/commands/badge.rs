use tauri::{AppHandle, Manager};

#[cfg(any(windows, test))]
const BADGE_SIZE: u32 = 32;
const BADGE_LIMIT: u32 = 9_999;

/// Dock and taskbar count. Zero clears the badge. Huge counts stop at 9999.
pub fn unread_badge_count(unread: u32) -> Option<i64> {
    if unread == 0 {
        None
    } else {
        Some(i64::from(unread.min(BADGE_LIMIT)))
    }
}

/// 5×7 glyphs. Each row keeps five bits.
#[cfg(any(windows, test))]
fn glyph(kind: u8) -> [u8; 7] {
    match kind {
        b'0' => [
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ],
        b'1' => [
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        b'2' => [
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ],
        b'3' => [
            0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110,
        ],
        b'4' => [
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ],
        b'5' => [
            0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
        ],
        b'6' => [
            0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ],
        b'7' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ],
        b'8' => [
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ],
        b'9' => [
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
        ],
        b'+' => [
            0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000,
        ],
        _ => [0; 7],
    }
}

#[cfg(any(windows, test))]
fn overlay_label(count: u32) -> String {
    if count > 99 {
        "99+".into()
    } else {
        count.to_string()
    }
}

/// 32×32 taskbar overlay. The circle is red and the count is white.
#[cfg(any(windows, test))]
pub fn badge_overlay_rgba(count: u32) -> Vec<u8> {
    let mut pixels = vec![0u8; (BADGE_SIZE * BADGE_SIZE * 4) as usize];
    let center = (BADGE_SIZE / 2) as i32;
    for y in 0..BADGE_SIZE as i32 {
        for x in 0..BADGE_SIZE as i32 {
            let dx = x - center;
            let dy = y - center;
            if dx * dx + dy * dy <= 14 * 14 {
                paint(&mut pixels, x as u32, y as u32, [196, 32, 40, 255]);
            }
        }
    }
    let label = overlay_label(count.max(1));
    let glyphs: Vec<[u8; 7]> = label.bytes().map(glyph).collect();
    let scale: u32 = if glyphs.len() > 2 { 1 } else { 2 };
    let gap = scale;
    let width = glyphs.len() as u32 * 5 * scale + (glyphs.len() as u32 - 1) * gap;
    let height = 7 * scale;
    let origin_x = (BADGE_SIZE - width) / 2;
    let origin_y = (BADGE_SIZE - height) / 2;
    for (index, rows) in glyphs.iter().enumerate() {
        let glyph_x = origin_x + index as u32 * (5 * scale + gap);
        for (row, bits) in rows.iter().enumerate() {
            for col in 0..5u32 {
                if bits & (1 << (4 - col)) == 0 {
                    continue;
                }
                for sy in 0..scale {
                    for sx in 0..scale {
                        paint(
                            &mut pixels,
                            glyph_x + col * scale + sx,
                            origin_y + row as u32 * scale + sy,
                            [255, 255, 255, 255],
                        );
                    }
                }
            }
        }
    }
    pixels
}

#[cfg(any(windows, test))]
fn paint(pixels: &mut [u8], x: u32, y: u32, color: [u8; 4]) {
    if x >= BADGE_SIZE || y >= BADGE_SIZE {
        return;
    }
    let index = ((y * BADGE_SIZE + x) * 4) as usize;
    pixels[index..index + 4].copy_from_slice(&color);
}

#[tauri::command]
pub fn set_unread_badge(app: AppHandle, count: u32) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let badge = unread_badge_count(count);
    let _ = window.set_badge_count(badge);
    #[cfg(windows)]
    {
        let icon = badge.map(|value| {
            let shown = u32::try_from(value).unwrap_or(BADGE_LIMIT);
            tauri::image::Image::new_owned(badge_overlay_rgba(shown), BADGE_SIZE, BADGE_SIZE)
        });
        let _ = window.set_overlay_icon(icon);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_clears_the_badge_and_huge_counts_stop_at_9999() {
        assert_eq!(unread_badge_count(0), None);
        assert_eq!(unread_badge_count(4), Some(4));
        assert_eq!(unread_badge_count(10_000), Some(9_999));
    }

    #[test]
    fn overlay_draws_a_white_count_on_a_red_circle() {
        let one = badge_overlay_rgba(1);
        let two = badge_overlay_rgba(2);
        assert_eq!(one.len(), 32 * 32 * 4);
        assert!(one.chunks(4).any(|pixel| pixel == [196, 32, 40, 255]));
        assert!(one.chunks(4).any(|pixel| pixel == [255, 255, 255, 255]));
        assert_ne!(one, two);
        assert_ne!(badge_overlay_rgba(99), badge_overlay_rgba(100));
    }
}
