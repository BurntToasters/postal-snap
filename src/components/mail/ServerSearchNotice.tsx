import { strings } from "../../i18n";

/** Offers the rest of an all-folder server search that stopped early. */
export function ServerSearchNotice({
  loading,
  onSearchMore,
}: {
  loading: boolean;
  /** Omitted when the search cannot continue. */
  onSearchMore?: () => void;
}) {
  return (
    <div className="server-search-notice" aria-live="polite">
      <p className="server-search-notice-text">
        {strings.mail.serverSearchStopped}
      </p>
      {onSearchMore ? (
        <button
          type="button"
          className="secondary-button"
          onClick={onSearchMore}
          disabled={loading}
        >
          {strings.mail.searchMoreFolders}
        </button>
      ) : null}
    </div>
  );
}
