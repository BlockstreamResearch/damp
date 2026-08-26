import { ClipboardCopyButton, type ClipboardNotice } from "./copyable-address";

export function RegistryPathRow({
  label,
  path,
  onNotice,
}: {
  label: string;
  path: string;
  onNotice?: (notice: ClipboardNotice) => void;
}) {
  return (
    <div className="registry-path-row">
      <code className="registry-path" title={path}>{path}</code>
      <ClipboardCopyButton
        value={path}
        resetKey={path}
        accessibleLabel={`Copy destination path for ${label}`}
        idleLabel="Copy path"
        copiedLabel="Path copied"
        className="button secondary registry-path-copy"
        onNotice={onNotice}
      />
    </div>
  );
}
