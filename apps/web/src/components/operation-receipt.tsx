import { Check, ExternalLink } from "lucide-react";

import { shortHash, type Deployment } from "../lib/domain";
import { transactionExplorerUrl, type OperationReceipt } from "../lib/operation-receipt";

export function OperationReceiptPanel({
  receipt,
  network,
  amountLabel,
  resetLabel,
  tone,
  onReset,
}: {
  receipt: OperationReceipt;
  network: Deployment["network"];
  amountLabel: string;
  resetLabel: string;
  tone: "holder" | "issuer";
  onReset: () => void;
}) {
  const explorer = transactionExplorerUrl(network, receipt.txid);
  return (
    <div className="operation-receipt" role="status">
      <Check size={26} />
      <h3>Broadcast accepted</h3>
      <p>This terminal receipt prevents the reviewed operation from being signed or broadcast again.</p>
      <dl>
        <div><dt>Transaction</dt><dd><code title={receipt.txid}>{shortHash(receipt.txid, 12, 10)}</code></dd></div>
        <div><dt>Amount</dt><dd>{amountLabel}</dd></div>
      </dl>
      {explorer && <a className="button secondary wide" href={explorer} target="_blank" rel="noreferrer">View transaction <ExternalLink size={14} /></a>}
      <button className={`button ${tone === "issuer" ? "issuer-primary" : "primary"} wide`} type="button" onClick={onReset}>{resetLabel}</button>
    </div>
  );
}
