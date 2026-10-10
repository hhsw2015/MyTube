import { AutoAwesome as EnhanceIcon } from '@mui/icons-material';
import { Button, Tooltip } from '@mui/material';
import React from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { useSnackbar } from '../../contexts/SnackbarContext';
import { useSettings } from '../../hooks/useSettings';
import { Video } from '../../types';
import {
    buildYtplayUrl,
    resolveHandoffUrl,
    type EnhancePlayer,
    type EnhanceTier,
} from '../../utils/enhancedPlayback';

interface EnhancedPlaybackButtonProps {
    video: Video;
}

/**
 * Hands the current video off to the local streamlink-ytplay GPU upscale
 * pipeline (via the `ytplay://` URL scheme) for enhanced playback in an external
 * player. Only works on a machine that has the ytplay scheme handler installed;
 * on others the scheme simply does nothing.
 */
const EnhancedPlaybackButton: React.FC<EnhancedPlaybackButtonProps> = ({ video }) => {
    const { t } = useLanguage();
    const { showSnackbar } = useSnackbar();
    const { data: settings } = useSettings();

    if (!settings?.enhancedPlaybackEnabled) {
        return null;
    }

    const tier: EnhanceTier = settings.enhancedPlaybackTier ?? 'quality';
    const player: EnhancePlayer = settings.enhancedPlaybackPlayer ?? 'iina';

    const handleClick = () => {
        const handoffUrl = resolveHandoffUrl(video, window.location.origin);
        if (!handoffUrl) {
            showSnackbar(t('enhancedPlaybackNoSource') || 'No playable source for enhanced playback');
            return;
        }
        const ytplayUrl = buildYtplayUrl({ handoffUrl, tier, player });
        // Launching a custom scheme navigates the tab; use a hidden anchor so the
        // page itself is not unloaded if the handler is missing.
        const a = document.createElement('a');
        a.href = ytplayUrl;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showSnackbar(t('enhancedPlaybackLaunched') || 'Launching enhanced player...');
    };

    return (
        <Tooltip title={t('enhancedPlaybackTooltip') || 'Upscale with the local GPU pipeline and play in an external player (requires the ytplay handler installed on this machine).'}>
            <Button
                size="small"
                variant="outlined"
                color="secondary"
                startIcon={<EnhanceIcon />}
                onClick={handleClick}
                sx={{ my: 1 }}
            >
                {t('enhancedPlayback') || 'Enhanced play'}
            </Button>
        </Tooltip>
    );
};

export default EnhancedPlaybackButton;
