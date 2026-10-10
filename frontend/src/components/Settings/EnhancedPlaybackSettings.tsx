import {
    Box,
    FormControl,
    FormControlLabel,
    InputLabel,
    MenuItem,
    Select,
    Switch,
    Typography,
} from '@mui/material';
import React from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { Settings } from '../../types';
import { SETTINGS_CONTROL_MAX_WIDTH } from './settingsLayout';

interface EnhancedPlaybackSettingsProps {
    settings: Settings;
    onChange: (field: keyof Settings, value: any) => void;
}

const TIERS: Array<{ value: NonNullable<Settings['enhancedPlaybackTier']>; label: string }> = [
    { value: 'speed', label: 'Speed · MetalFX · smoothest 4K60 (SDR only)' },
    { value: 'quality', label: 'Quality · CuNNy super-res + temporal' },
    { value: 'max', label: 'Max · strongest temporal (anime / noisy sources)' },
    { value: 'photo', label: 'Photo · gentle temporal, keeps skin texture' },
];

const EnhancedPlaybackSettings: React.FC<EnhancedPlaybackSettingsProps> = ({ settings, onChange }) => {
    const { t } = useLanguage();

    return (
        <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {t('enhancedPlaybackDescription') ||
                    'Hand a video off to a local GPU upscale pipeline (streamlink-ytplay) and play it in an external player (IINA / SenPlayer). Only works on a machine with the ytplay scheme handler installed.'}
            </Typography>

            <FormControlLabel
                control={
                    <Switch
                        checked={settings.enhancedPlaybackEnabled || false}
                        onChange={(e) => onChange('enhancedPlaybackEnabled', e.target.checked)}
                    />
                }
                label={t('enableEnhancedPlayback') || 'Enable enhanced playback'}
            />

            {settings.enhancedPlaybackEnabled && (
                <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: SETTINGS_CONTROL_MAX_WIDTH }}>
                    <FormControl fullWidth size="small">
                        <InputLabel id="enhanced-playback-player-label">
                            {t('enhancedPlaybackPlayer') || 'External player'}
                        </InputLabel>
                        <Select
                            labelId="enhanced-playback-player-label"
                            label={t('enhancedPlaybackPlayer') || 'External player'}
                            value={settings.enhancedPlaybackPlayer ?? 'iina'}
                            onChange={(e) => onChange('enhancedPlaybackPlayer', e.target.value)}
                        >
                            <MenuItem value="iina">IINA</MenuItem>
                            <MenuItem value="senplayer">SenPlayer</MenuItem>
                        </Select>
                    </FormControl>

                    <FormControl fullWidth size="small">
                        <InputLabel id="enhanced-playback-tier-label">
                            {t('enhancedPlaybackTier') || 'Enhance tier'}
                        </InputLabel>
                        <Select
                            labelId="enhanced-playback-tier-label"
                            label={t('enhancedPlaybackTier') || 'Enhance tier'}
                            value={settings.enhancedPlaybackTier ?? 'quality'}
                            onChange={(e) => onChange('enhancedPlaybackTier', e.target.value)}
                        >
                            {TIERS.map((tier) => (
                                <MenuItem key={tier.value} value={tier.value}>
                                    {tier.label}
                                </MenuItem>
                            ))}
                        </Select>
                    </FormControl>
                </Box>
            )}
        </Box>
    );
};

export default EnhancedPlaybackSettings;
