// OWNER: reader agent. Placeholder — replace the body, keep the props.
export interface LabelScannerProps {
  open: boolean;
  onClose: () => void;
  /** A sharp, well-framed still of the nutrition panel. */
  onCapture: (image: Blob) => void;
}

export function LabelScanner(_props: LabelScannerProps) {
  return null;
}
