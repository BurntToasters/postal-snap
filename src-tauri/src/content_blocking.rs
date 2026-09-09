use std::sync::OnceLock;

use adblock::{
    lists::{ParseOptions, RuleTypes},
    request::Request,
    Engine, FilterSet,
};
use url::Url;

const EASYLIST: &str = include_str!("../filters/easylist.txt");
const EASYPRIVACY: &str = include_str!("../filters/easyprivacy.txt");
static ENGINE: OnceLock<Engine> = OnceLock::new();

fn build_engine(lists: &[&str]) -> Engine {
    let mut filters = FilterSet::new(false);
    for list in lists {
        filters.add_filter_list(
            (*list).to_owned(),
            ParseOptions {
                rule_types: RuleTypes::NetworkOnly,
                ..ParseOptions::default()
            },
        );
    }
    Engine::new_with_filter_set(filters)
}

fn matches_image(engine: &Engine, url: &Url) -> Result<bool, String> {
    // Email has no trusted publisher origin. All remote images are third-party;
    // neither sender headers nor the Tauri host can grant list exceptions.
    let request = Request::new(url.as_str(), "", "image", "GET")
        .map_err(|_| "This image address could not be checked.".to_string())?;
    Ok(engine.check_network_request(&request).should_block())
}

fn engine() -> &'static Engine {
    ENGINE.get_or_init(|| build_engine(&[EASYLIST, EASYPRIVACY]))
}

pub async fn warmup() {
    let _ = tokio::task::spawn_blocking(engine).await;
}

pub async fn blocks_image(url: &Url) -> Result<bool, String> {
    let url = url.clone();
    // Compilation and matching never occupy the async mail worker. No URL or
    // rule debug information crosses IPC or enters logs.
    tokio::task::spawn_blocking(move || matches_image(engine(), &url))
        .await
        .map_err(|_| "Image privacy protection is unavailable. Please try again.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn respects_image_types_exceptions_and_third_party_rules() {
        let engine = build_engine(&["||tracker.test^$image,third-party\n@@||tracker.test/photo.jpg$image\n||scripts.test^$script\n||other.test^$image,domain=sender.test\n"]);
        for (url, blocked) in [
            ("https://tracker.test/pixel.gif?recipient=synthetic", true),
            ("https://tracker.test/photo.jpg", false),
            ("https://nottracker.test/photo.jpg", false),
            ("https://scripts.test/photo.jpg", false),
            ("https://other.test/photo.jpg", false),
        ] {
            assert_eq!(
                matches_image(&engine, &Url::parse(url).unwrap()).unwrap(),
                blocked
            );
        }
    }

    #[test]
    fn uses_official_lists_for_tracking_and_ad_images() {
        let engine = engine();
        for (url, blocked) in [
            ("https://www.google-analytics.com/collect?v=1", true),
            ("https://images.example.test/email/track/pixel.gif", true),
            ("https://images.example.test/ad/image/banner.png", true),
            ("https://images.example.test/family/photo.jpg", false),
        ] {
            assert_eq!(
                matches_image(engine, &Url::parse(url).unwrap()).unwrap(),
                blocked
            );
        }
    }

    #[tokio::test]
    async fn warmup_compiles_the_shared_engine() {
        warmup().await;
        assert!(ENGINE.get().is_some());
    }

    #[test]
    fn does_not_apply_cosmetic_rules_or_rewrite_signed_image_urls() {
        let engine = build_engine(&["##img\n||images.test^$removeparam=token\n"]);
        let url = Url::parse("https://images.test/photo.jpg?token=synthetic").unwrap();
        assert!(!matches_image(&engine, &url).unwrap());
        assert_eq!(url.query(), Some("token=synthetic"));
    }
}
