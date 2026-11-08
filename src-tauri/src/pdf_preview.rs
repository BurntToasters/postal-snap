//! In-memory PDF page previews. Pages are rasterized to PNG with hayro, a
//! pure-Rust renderer, and handed to the UI as data URLs. Nothing is written
//! to disk and PDF content never reaches the privileged webview.

use crate::models::AttachmentPreview;
use crate::security::detect_image_mime;
use crate::strings::preview::PDF_UNAVAILABLE;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use hayro::hayro_interpret::InterpreterSettings;
use hayro::hayro_syntax::Pdf;
use hayro::vello_cpu::color::palette::css::WHITE;
use hayro::{PixmapSettings, RenderCache, RenderSettings};
use std::time::Duration;

/// Pages rendered per document; later pages only set `pages_truncated`.
pub(crate) const MAX_RENDERED_PAGES: usize = 20;
/// Widest rendered page, in pixels.
pub(crate) const MAX_PAGE_WIDTH: u32 = 1600;
/// Largest rendered page, in pixels.
pub(crate) const MAX_PAGE_PIXELS: u64 = 4_000_000;
/// PNG bytes per document before base64, so one preview stays bounded over IPC.
pub(crate) const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;
/// Wall-clock budget for one preview, including queueing on the blocking pool.
const PREVIEW_TIMEOUT: Duration = Duration::from_secs(10);
/// Never upscale past 2x; small pages stay small.
const MAX_SCALE: f32 = 2.0;

/// Rendered pages for one PDF.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RenderedPdf {
    pub pages: Vec<String>,
    pub page_count: u32,
    pub pages_truncated: bool,
}

/// Render a PDF into a preview. Blocking work runs on the blocking pool.
pub(crate) async fn render_pdf_pages(
    filename: String,
    bytes: Vec<u8>,
) -> Result<AttachmentPreview, String> {
    let size = bytes.len() as u64;
    let rendered = bounded(PREVIEW_TIMEOUT, move || render_document(&bytes)).await?;
    Ok(AttachmentPreview {
        filename,
        content_type: "application/pdf".into(),
        size,
        text: None,
        image_data_url: None,
        pages: Some(rendered.pages),
        page_count: Some(rendered.page_count),
        pages_truncated: rendered.pages_truncated,
    })
}

/// Run `work` on the blocking pool. Past `limit` the caller gets an error;
/// the thread may finish later, and the page and pixel caps bound its work.
async fn bounded<T: Send + 'static>(
    limit: Duration,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let handle = tokio::task::spawn_blocking(move || guard(work));
    match tokio::time::timeout(limit, handle).await {
        Ok(Ok(result)) => result,
        _ => Err(PDF_UNAVAILABLE.to_string()),
    }
}

/// Run `work`, turning a panic into an error so one bad file fails one task.
pub(crate) fn guard<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)) {
        Ok(result) => result,
        Err(_) => Err(PDF_UNAVAILABLE.to_string()),
    }
}

/// Scale that fits a page inside the width and pixel caps. None when the
/// page size is unusable.
pub(crate) fn fit_scale(width: f32, height: f32) -> Option<f32> {
    if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
        return None;
    }
    let by_width = MAX_PAGE_WIDTH as f32 / width;
    let by_pixels = (MAX_PAGE_PIXELS as f32 / (width * height)).sqrt();
    let scale = MAX_SCALE.min(by_width).min(by_pixels);
    (scale.is_finite() && scale > 0.0).then_some(scale)
}

/// Render the first pages of a PDF. Encrypted, malformed or empty files error.
pub(crate) fn render_document(bytes: &[u8]) -> Result<RenderedPdf, String> {
    render_document_within(bytes, MAX_OUTPUT_BYTES)
}

/// Like `render_document`, stopping once the PNG bytes would exceed `budget`.
fn render_document_within(bytes: &[u8], budget: usize) -> Result<RenderedPdf, String> {
    let unavailable = || PDF_UNAVAILABLE.to_string();
    let pdf = Pdf::new(bytes.to_vec()).map_err(|_| unavailable())?;
    let pages = pdf.pages();
    let page_count = pages.len();
    if page_count == 0 {
        return Err(unavailable());
    }
    let interpreter = InterpreterSettings::default();
    let render = RenderSettings::default();
    let cache = RenderCache::new();
    let mut rendered = Vec::with_capacity(page_count.min(MAX_RENDERED_PAGES));
    let mut spent = 0usize;
    for page in pages.iter().take(MAX_RENDERED_PAGES) {
        let (width, height) = page.render_dimensions();
        let scale = fit_scale(width, height).ok_or_else(unavailable)?;
        let pixmap = hayro::render(
            page,
            &cache,
            &interpreter,
            &render,
            &PixmapSettings {
                x_scale: scale,
                y_scale: scale,
                bg_color: WHITE,
            },
        );
        let (pw, ph) = (u32::from(pixmap.width()), u32::from(pixmap.height()));
        if pw == 0
            || ph == 0
            || pw > MAX_PAGE_WIDTH
            || u64::from(pw) * u64::from(ph) > MAX_PAGE_PIXELS
        {
            return Err(unavailable());
        }
        let png = pixmap.into_png().map_err(|_| unavailable())?;
        if detect_image_mime(&png) != Some("image/png") {
            return Err(unavailable());
        }
        if spent.saturating_add(png.len()) > budget {
            break;
        }
        spent += png.len();
        rendered.push(format!("data:image/png;base64,{}", STANDARD.encode(&png)));
    }
    if rendered.is_empty() {
        return Err(unavailable());
    }
    Ok(RenderedPdf {
        page_count: u32::try_from(page_count).unwrap_or(u32::MAX),
        pages_truncated: rendered.len() < page_count,
        pages: rendered,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::attachments::preview_bytes;
    use crate::security::detect_image_mime;

    /// A small, valid PDF with one filled rectangle per page.
    fn build_pdf(pages: &[(u32, u32)]) -> Vec<u8> {
        let count = pages.len();
        let kids: String = (0..count).map(|i| format!("{} 0 R ", 3 + 2 * i)).collect();
        let mut bodies: Vec<Vec<u8>> = vec![
            b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
            format!("<< /Type /Pages /Kids [{kids}] /Count {count} >>").into_bytes(),
        ];
        for (i, (w, h)) in pages.iter().enumerate() {
            bodies.push(
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] /Contents {} 0 R /Resources << >> >>",
                    4 + 2 * i
                )
                .into_bytes(),
            );
            let content = format!("0 0 1 rg 0 0 {w} {h} re f");
            bodies.push(
                format!(
                    "<< /Length {} >>\nstream\n{content}\nendstream",
                    content.len()
                )
                .into_bytes(),
            );
        }
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in bodies.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj\n", i + 1).into_bytes());
            out.extend(body);
            out.extend(b"\nendobj\n");
        }
        let xref_at = out.len();
        out.extend(format!("xref\n0 {}\n", bodies.len() + 1).into_bytes());
        out.extend(b"0000000000 65535 f \n");
        for offset in offsets {
            out.extend(format!("{offset:010} 00000 n \n").into_bytes());
        }
        out.extend(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
                bodies.len() + 1
            )
            .into_bytes(),
        );
        out
    }

    /// Same shape as `build_pdf`, but with an /Encrypt entry that needs a
    /// user password nobody has.
    fn build_encrypted_pdf() -> Vec<u8> {
        let o = "00".repeat(32);
        let u = "11".repeat(32);
        let bodies = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>".to_string(),
            format!("<< /Filter /Standard /V 1 /R 2 /O <{o}> /U <{u}> /P -4 >>"),
        ];
        let mut out = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, body) in bodies.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj\n{body}\nendobj\n", i + 1).into_bytes());
        }
        let xref_at = out.len();
        out.extend(format!("xref\n0 {}\n", bodies.len() + 1).into_bytes());
        out.extend(b"0000000000 65535 f \n");
        for offset in offsets {
            out.extend(format!("{offset:010} 00000 n \n").into_bytes());
        }
        out.extend(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R /Encrypt 4 0 R /ID [<00> <00>] >>\nstartxref\n{xref_at}\n%%EOF\n",
                bodies.len() + 1
            )
            .into_bytes(),
        );
        out
    }

    fn png_dimensions(png: &[u8]) -> (u32, u32) {
        assert_eq!(&png[12..16], b"IHDR", "not a PNG header");
        let w = u32::from_be_bytes(png[16..20].try_into().unwrap());
        let h = u32::from_be_bytes(png[20..24].try_into().unwrap());
        (w, h)
    }

    fn decode_page(url: &str) -> Vec<u8> {
        let payload = url
            .strip_prefix("data:image/png;base64,")
            .expect("page must be a PNG data URL");
        STANDARD.decode(payload).expect("valid base64")
    }

    // Failure modes, listed before the implementation:
    // FM1 malformed bytes error without panicking.
    // FM2 a password-protected PDF errors.
    // FM3 a PDF with no pages errors.
    // FM4 more than 20 pages renders 20 and sets pages_truncated.
    // FM5 exactly 20 pages is not truncated.
    // FM6 wide or large pages are scaled under the width and pixel caps.
    // FM7 every page is a PNG that passes image sniffing.
    // FM8 a panic inside the work becomes an error; FM9 unusable sizes have no scale.
    // FM10 a .pdf name without %PDF magic is refused; FM11 oversize bytes are refused.
    // FM12 the PNG output budget stops rendering and sets pages_truncated.
    // FM13 work past the time limit errors; fast work returns its result.

    #[test]
    fn fm1_malformed_pdf_is_an_error_not_a_panic() {
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend(std::iter::repeat_n(0xA5u8, 4096));
        bytes.extend(b"\nstartxref\n999999\n%%EOF");
        assert!(render_document(&bytes).is_err());
        assert!(render_document(b"%PDF-").is_err());
        assert!(render_document(&[]).is_err());
    }

    #[test]
    fn fm2_encrypted_pdf_is_an_error() {
        let bytes = build_encrypted_pdf();
        let loaded = hayro::hayro_syntax::Pdf::new(bytes.clone());
        assert!(
            matches!(
                loaded,
                Err(hayro::hayro_syntax::LoadPdfError::Decryption(_))
            ),
            "fixture must be rejected for encryption, not for malformation"
        );
        assert!(render_document(&bytes).is_err());
    }

    #[test]
    fn fm3_pdf_without_pages_is_an_error() {
        assert!(render_document(&build_pdf(&[])).is_err());
    }

    #[test]
    fn fm4_page_cap_sets_truncation() {
        let pages = vec![(100, 100); 25];
        let rendered = render_document(&build_pdf(&pages)).expect("valid pdf");
        assert_eq!(rendered.pages.len(), MAX_RENDERED_PAGES);
        assert_eq!(rendered.page_count, 25);
        assert!(rendered.pages_truncated);
    }

    #[test]
    fn fm12_output_budget_stops_rendering_and_marks_truncation() {
        let bytes = build_pdf(&[(100, 100), (100, 100)]);
        assert!(render_document_within(&bytes, 1).is_err(), "no page fits");

        let full = render_document(&bytes).expect("valid pdf");
        let first_png = decode_page(&full.pages[0]).len();
        let partial = render_document_within(&bytes, first_png).expect("first page fits");
        assert_eq!(partial.pages.len(), 1);
        assert_eq!(partial.page_count, 2);
        assert!(partial.pages_truncated);
    }

    #[tokio::test]
    async fn fm13_work_past_time_limit_is_an_error() {
        let slow = bounded(Duration::from_millis(20), || {
            std::thread::sleep(Duration::from_millis(400));
            Ok(1u8)
        })
        .await;
        assert_eq!(slow, Err(PDF_UNAVAILABLE.to_string()));
        let fast = bounded(Duration::from_secs(5), || Ok(2u8)).await;
        assert_eq!(fast, Ok(2u8));
    }

    #[test]
    fn fm5_exact_page_cap_is_not_truncated() {
        let pages = vec![(100, 100); MAX_RENDERED_PAGES];
        let rendered = render_document(&build_pdf(&pages)).expect("valid pdf");
        assert_eq!(rendered.pages.len(), MAX_RENDERED_PAGES);
        assert_eq!(rendered.page_count, MAX_RENDERED_PAGES as u32);
        assert!(!rendered.pages_truncated);
    }

    #[test]
    fn fm6_width_and_pixel_caps_hold() {
        let wide = render_document(&build_pdf(&[(5000, 100)])).expect("valid pdf");
        let (w, h) = png_dimensions(&decode_page(&wide.pages[0]));
        assert!(w <= MAX_PAGE_WIDTH && h > 0, "wide page was {w}x{h}");

        let square = render_document(&build_pdf(&[(3000, 3000)])).expect("valid pdf");
        let (w, h) = png_dimensions(&decode_page(&square.pages[0]));
        assert!(
            u64::from(w) * u64::from(h) <= MAX_PAGE_PIXELS,
            "was {w}x{h}"
        );
    }

    #[test]
    fn fm7_every_page_passes_image_sniffing() {
        let rendered = render_document(&build_pdf(&[(120, 80), (60, 200)])).expect("valid pdf");
        assert_eq!(rendered.pages.len(), 2);
        for url in &rendered.pages {
            let png = decode_page(url);
            assert_eq!(detect_image_mime(&png), Some("image/png"));
        }
    }

    #[test]
    fn fm8_panic_inside_work_becomes_error() {
        let result: Result<(), String> = guard(|| panic!("boom"));
        assert!(result.is_err());
        let ok: Result<u8, String> = guard(|| Ok(7));
        assert_eq!(ok, Ok(7));
    }

    #[test]
    fn fm9_unusable_page_sizes_have_no_scale() {
        assert_eq!(fit_scale(0.0, 100.0), None);
        assert_eq!(fit_scale(100.0, -1.0), None);
        assert_eq!(fit_scale(f32::NAN, 100.0), None);
        assert_eq!(fit_scale(f32::INFINITY, 100.0), None);
        let scale = fit_scale(3000.0, 3000.0).expect("usable");
        assert!(3000.0 * scale * 3000.0 * scale <= MAX_PAGE_PIXELS as f32 * 1.001);
    }

    #[tokio::test]
    async fn fm10_pdf_name_without_magic_is_refused() {
        let text = b"Hello, this is not a PDF.".to_vec();
        let result = preview_bytes("notes.pdf".into(), "application/pdf", text).await;
        assert!(result.is_err());
        let result = preview_bytes(
            "notes.pdf".into(),
            "application/octet-stream",
            b"MZ\x90".to_vec(),
        )
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn fm11_oversize_pdf_is_refused_before_parsing() {
        let bytes = vec![0u8; crate::commands::attachments::MAX_PREVIEW_BYTES + 1];
        let result = preview_bytes("big.pdf".into(), "application/pdf", bytes).await;
        assert_eq!(
            result.unwrap_err(),
            "This attachment is too large to preview."
        );
    }

    #[tokio::test]
    async fn valid_pdf_previews_through_preview_bytes() {
        let preview = preview_bytes("doc.pdf".into(), "application/pdf", build_pdf(&[(64, 64)]))
            .await
            .expect("valid pdf");
        assert_eq!(preview.page_count, Some(1));
        assert!(!preview.pages_truncated);
        assert_eq!(preview.pages.as_ref().map(Vec::len), Some(1));
        assert!(preview.image_data_url.is_none());
    }
}
