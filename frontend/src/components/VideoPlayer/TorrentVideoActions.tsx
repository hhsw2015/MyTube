import { Download as DownloadIcon } from '@mui/icons-material';
import { Box, Button, Chip, Tooltip } from '@mui/material';
import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useSnackbar } from '../../contexts/SnackbarContext';
import { api } from '../../utils/apiClient';

interface TorrentVideoActionsProps {
    videoId: string;
}

/**
 * Badge + "Download for offline" (Mode B) action for a stream-mode torrent
 * video. The badge is the "unavailable state" affordance (design §8): it tells
 * the user playback depends on the live swarm, so a dead entry reads differently
 * from a broken local file.
 */
const TorrentVideoActions: React.FC<TorrentVideoActionsProps> = ({ videoId }) => {
    const { t } = useLanguage();
    const { userRole, loginRequired } = useAuth();
    const { showSnackbar } = useSnackbar();
    const [downloading, setDownloading] = useState(false);
    const canManage = userRole === 'admin' || loginRequired === false;

    const handleOffline = async () => {
        setDownloading(true);
        try {
            await api.post(`/torrent/${videoId}/download`);
            showSnackbar(t('offlineDownloadStarted') || 'Downloading for offline...');
        } catch (error) {
            console.error('Error starting offline download:', error);
            showSnackbar(t('error') || 'Error');
            setDownloading(false);
        }
    };

    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, my: 1, flexWrap: 'wrap' }}>
            <Tooltip title={t('torrentStreamTooltip') || 'Streamed live from the torrent swarm; may stop playing if no seeders remain.'}>
                <Chip
                    size="small"
                    color="warning"
                    variant="outlined"
                    label={t('torrentStreamBadge') || 'Torrent · live stream'}
                />
            </Tooltip>
            {canManage && (
                <Button
                    size="small"
                    variant="outlined"
                    startIcon={<DownloadIcon />}
                    onClick={handleOffline}
                    disabled={downloading}
                >
                    {downloading
                        ? t('downloadingForOffline') || 'Downloading...'
                        : t('downloadForOffline') || 'Download for offline'}
                </Button>
            )}
        </Box>
    );
};

export default TorrentVideoActions;
