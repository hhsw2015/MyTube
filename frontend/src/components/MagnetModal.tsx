import {
    Box,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    FormControlLabel,
    List,
    ListItem,
    TextField,
    Typography,
} from '@mui/material';
import React, { useEffect, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';

export interface TorrentFile {
    id: number;
    path: string;
    length: number;
}

interface MagnetModalProps {
    open: boolean;
    onClose: () => void;
    /** Inspect the magnet and return its file list for the picker. */
    onInspect: (magnet: string) => Promise<TorrentFile[]>;
    /** Add the magnet; fileIds undefined = add the largest file automatically. */
    onConfirm: (magnet: string, fileIds?: number[]) => void | Promise<void>;
    /** Prefill + auto-inspect this magnet when the dialog opens (search-box path). */
    initialMagnet?: string;
}

const formatBytes = (bytes: number): string => {
    if (!bytes || bytes < 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const MagnetModal: React.FC<MagnetModalProps> = ({ open, onClose, onInspect, onConfirm, initialMagnet }) => {
    const { t } = useLanguage();
    const [magnet, setMagnet] = useState('');
    const [files, setFiles] = useState<TorrentFile[] | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [inspecting, setInspecting] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    // Search-box path: when opened with a prefilled magnet, auto-inspect so the
    // file list shows immediately.
    useEffect(() => {
        if (!open || !initialMagnet) return;
        setMagnet(initialMagnet);
        if (!/^magnet:\?/i.test(initialMagnet.trim())) return;
        let cancelled = false;
        setInspecting(true);
        void (async () => {
            try {
                const result = await onInspect(initialMagnet.trim());
                if (cancelled) return;
                setFiles(result);
                setSelected(new Set(result.length > 0 ? [result[0].id] : []));
            } catch {
                /* error surfaced by caller */
            } finally {
                if (!cancelled) setInspecting(false);
            }
        })();
        return () => { cancelled = true; };
    }, [open, initialMagnet, onInspect]);

    const trimmed = magnet.trim();
    const isValid = /^magnet:\?/i.test(trimmed);

    const reset = () => {
        setMagnet('');
        setFiles(null);
        setSelected(new Set());
    };

    const handleInspect = async () => {
        if (!isValid) return;
        setInspecting(true);
        try {
            const result = await onInspect(trimmed);
            setFiles(result);
            // Pre-select the largest file (inspect returns largest-first).
            setSelected(new Set(result.length > 0 ? [result[0].id] : []));
        } finally {
            setInspecting(false);
        }
    };

    const toggle = (id: number) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleConfirm = async () => {
        if (!isValid) return;
        setSubmitting(true);
        try {
            // With an inspected file list, send the selection; otherwise let the
            // backend pick the largest file.
            const fileIds = files ? Array.from(selected) : undefined;
            await onConfirm(trimmed, fileIds);
            reset();
            onClose();
        } finally {
            setSubmitting(false);
        }
    };

    const handleClose = () => {
        if (submitting || inspecting) return;
        reset();
        onClose();
    };

    const busy = submitting || inspecting;
    const canAdd = isValid && !busy && (!files || selected.size > 0);

    return (
        <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
            <DialogTitle>{t('addMagnet') || 'Add magnet'}</DialogTitle>
            <DialogContent>
                <DialogContentText sx={{ mb: 2 }}>
                    {t('addMagnetHelp') ||
                        'Paste a magnet link to stream it while it downloads via TorrServer.'}
                </DialogContentText>
                <TextField
                    autoFocus
                    fullWidth
                    multiline
                    minRows={2}
                    placeholder="magnet:?xt=urn:btih:..."
                    value={magnet}
                    onChange={(e) => {
                        setMagnet(e.target.value);
                        // Editing the magnet invalidates a prior inspection.
                        setFiles(null);
                        setSelected(new Set());
                    }}
                    error={trimmed.length > 0 && !isValid}
                    helperText={
                        trimmed.length > 0 && !isValid
                            ? t('invalidMagnet') || 'Not a valid magnet link'
                            : ' '
                    }
                />

                <Box sx={{ mt: 1 }}>
                    <Button onClick={handleInspect} disabled={!isValid || busy} size="small">
                        {inspecting
                            ? t('inspecting') || 'Inspecting...'
                            : t('inspectFiles') || 'Choose files...'}
                    </Button>
                </Box>

                {files && (
                    <Box sx={{ mt: 1 }}>
                        {files.length === 0 ? (
                            <Typography variant="body2" color="text.secondary">
                                {t('noPlayableFiles') || 'No files found in this torrent.'}
                            </Typography>
                        ) : (
                            <List dense sx={{ maxHeight: 240, overflow: 'auto' }}>
                                {files.map((file) => (
                                    <ListItem key={file.id} disablePadding>
                                        <FormControlLabel
                                            sx={{ width: '100%' }}
                                            control={
                                                <Checkbox
                                                    checked={selected.has(file.id)}
                                                    onChange={() => toggle(file.id)}
                                                />
                                            }
                                            label={
                                                <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                                                    {file.path}
                                                    {file.length > 0 && (
                                                        <Typography component="span" color="text.secondary">
                                                            {`  (${formatBytes(file.length)})`}
                                                        </Typography>
                                                    )}
                                                </Typography>
                                            }
                                        />
                                    </ListItem>
                                ))}
                            </List>
                        )}
                    </Box>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={handleClose} disabled={busy}>
                    {t('cancel') || 'Cancel'}
                </Button>
                <Button variant="contained" onClick={handleConfirm} disabled={!canAdd}>
                    {t('add') || 'Add'}
                </Button>
            </DialogActions>
        </Dialog>
    );
};

export default MagnetModal;
