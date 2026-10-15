import { FileArtifactMetadata, type FileDelivery, type Registry } from '@femlab/registry';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Cmd, type Dispatch } from '../ui/cmd';

export interface CompletedFileRowProps {
  file: FileDelivery;
  registry: Pick<Registry, 'query'>;
  dispatch: Dispatch;
  version: number;
}
const reasons: Record<NonNullable<FileDelivery['unavailable']>, string> = {
  oversize: 'Download unavailable: file exceeds the retention limit',
  capacity: 'Download unavailable: completed-file cache is full',
  unavailable: 'Download unavailable: file could not be retained',
  expired: 'Download unavailable: completed file has expired',
  unsupported: 'Download unavailable: this host does not retain completed files',
};

/** The query reads metadata only; the registered download Command checks the id again at use. */
export function CompletedFileRow({ file, registry, dispatch, version }: CompletedFileRowProps) {
  const receiptKey = JSON.stringify([file.name, file.mime, file.bytes, file.unavailable]);
  const owner = useRef({ registry, id: file.id, version, receiptKey, epoch: 0 });
  if (owner.current.registry !== registry || owner.current.id !== file.id || owner.current.version !== version || owner.current.receiptKey !== receiptKey) {
    owner.current = { registry, id: file.id, version, receiptKey, epoch: owner.current.epoch + 1 };
  }
  const epoch = owner.current.epoch;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [availability, setAvailability] = useState({ epoch: -1, ready: false, pending: false, reason: '' });
  useEffect(() => {
    let active = true;
    const current = () => active && owner.current.epoch === epoch;
    if (!file.id || file.unavailable) return () => { active = false; };
    setAvailability({ epoch, ready: false, pending: false, reason: 'Checking download availability…' });
    void registry.query({ query: 'query.fileDelivery', id: file.id }).then(value => {
      if (!current()) return;
      const envelope = value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
      const parsed = FileArtifactMetadata.safeParse(envelope?.['file']);
      const ready = parsed.success && parsed.data.id === file.id
        && (parsed.data.name === file.name || (file.to === 'download' && parsed.data.name.split('/').at(-1) === file.name))
        && (file.bytes === undefined || parsed.data.bytes === file.bytes)
        && (file.mime === undefined || parsed.data.mime === file.mime);
      setAvailability({ epoch, ready, pending: false, reason: ready ? '' : 'Download unavailable: completed file has expired or is not retained' });
    }).catch(() => {
      if (current()) setAvailability({ epoch, ready: false, pending: false, reason: 'Download unavailable: completed file metadata could not be read' });
    });
    return () => { active = false; };
  }, [registry, file.id, file.name, file.bytes, file.mime, file.unavailable, version, epoch]);
  const reason = file.unavailable ? reasons[file.unavailable] : !file.id
    ? 'Download unavailable: this receipt has no retained file'
    : availability.epoch === epoch ? availability.reason : 'Checking download availability…';
  const ready = Boolean(file.id && !file.unavailable && availability.epoch === epoch && availability.ready && !availability.pending);
  return <div class="files-row">
    <span class="path">{file.name}</span>
    <span class="faint">{file.to === 'folder' ? 'project folder' : 'download'}</span>
    <span class="file-size">{file.bytes === undefined ? 'Size unavailable' : `${file.bytes} B`}</span>
    <Cmd dispatch={dispatch} cmd="clipboard.copy" title="Copy the filename" args={{ what: { kind: 'text', text: file.name } }}>copy</Cmd>
    <Cmd dispatch={dispatch} cmd="file.download" args={{ id: file.id }} title={reason || 'Download the original completed file again'} disabled={!ready} onRun={() => {
      if (!ready) return;
      setAvailability({ epoch, ready: true, pending: true, reason: '' });
      void dispatch({ cmd: 'file.download', id: file.id }).then(() => {
        if (mounted.current && owner.current.epoch === epoch) setAvailability({ epoch, ready: true, pending: false, reason: '' });
      }).catch(() => {
        if (mounted.current && owner.current.epoch === epoch) setAvailability({ epoch, ready: false, pending: false, reason: 'Download unavailable: completed file expired or delivery failed' });
      });
    }}>Download again</Cmd>
    {reason ? <span class="faint file-unavailable" role="status">{reason}</span> : null}
  </div>;
}
