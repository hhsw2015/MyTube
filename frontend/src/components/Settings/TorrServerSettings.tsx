import {
    Alert,
    Box,
    Button,
    FormControlLabel,
    Switch,
    TextField,
    Typography,
} from '@mui/material';
import React, { useState } from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { Settings } from '../../types';
import { api } from '../../utils/apiClient';
import { SETTINGS_CONTROL_MAX_WIDTH } from './settingsLayout';

interface TorrServerSettingsProps {
    settings: Settings;
    onChange: (field: keyof Settings, value: any) => void;
}

const validateBaseUrl = (url: string): string | null => {
    if (!url.trim()) {
        return 'This field is required';
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return 'URL must start with http:// or https://';
        }
    } catch {
        return 'Invalid URL format';
    }
    return null;
};

const TorrServerSettings: React.FC<TorrServerSettingsProps> = ({ settings, onChange }) => {
    const { t } = useLanguage();
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<
        { type: 'success' | 'error'; message: string } | null
    >(null);

    const baseUrlError =
        settings.torrServerEnabled && settings.torrServerBaseUrl
            ? validateBaseUrl(settings.torrServerBaseUrl)
            : null;

    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            // Health checks the server as currently saved; prompt a save first if
            // the base URL was just edited.
            const response = await api.get('/torrent/health');
            const ok = Boolean(response.data?.ok);
            setTestResult(
                ok
                    ? { type: 'success', message: t('torrServerReachable') || 'TorrServer is reachable' }
                    : { type: 'error', message: t('torrServerUnreachable') || 'Could not reach TorrServer (save settings first, then retry)' }
            );
        } catch {
            setTestResult({
                type: 'error',
                message: t('torrServerUnreachable') || 'Could not reach TorrServer (save settings first, then retry)',
            });
        } finally {
            setTesting(false);
        }
    };

    return (
        <Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {t('torrServerDescription') ||
                    'Stream magnet links while they download via an external TorrServer instance. Playback is proxied through MyTube, so the browser never talks to TorrServer directly.'}
            </Typography>

            <FormControlLabel
                control={
                    <Switch
                        checked={settings.torrServerEnabled || false}
                        onChange={(e) => onChange('torrServerEnabled', e.target.checked)}
                    />
                }
                label={t('enableTorrServer') || 'Enable TorrServer'}
            />

            {settings.torrServerEnabled && (
                <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2, maxWidth: SETTINGS_CONTROL_MAX_WIDTH }}>
                    <TextField
                        label={t('torrServerBaseUrl') || 'TorrServer base URL'}
                        value={settings.torrServerBaseUrl || ''}
                        onChange={(e) => onChange('torrServerBaseUrl', e.target.value)}
                        placeholder="http://torrserver:8090"
                        helperText={
                            t('torrServerBaseUrlHelper') ||
                            'The in-network address the MyTube backend uses to reach TorrServer.'
                        }
                        error={!!baseUrlError}
                        required
                        fullWidth
                    />

                    <TextField
                        label={t('torrServerAuth') || 'Auth (user:pass, optional)'}
                        value={settings.torrServerAuth || ''}
                        onChange={(e) => onChange('torrServerAuth', e.target.value)}
                        type="password"
                        helperText={
                            t('torrServerAuthHelper') ||
                            'Optional HTTP Basic credentials if your TorrServer requires auth.'
                        }
                        fullWidth
                    />

                    <Box>
                        <Button
                            variant="outlined"
                            size="small"
                            onClick={handleTest}
                            disabled={testing || !!baseUrlError}
                        >
                            {testing
                                ? t('testing') || 'Testing...'
                                : t('testConnection') || 'Test connection'}
                        </Button>
                    </Box>

                    {testResult && (
                        <Alert severity={testResult.type}>{testResult.message}</Alert>
                    )}
                </Box>
            )}
        </Box>
    );
};

export default TorrServerSettings;
