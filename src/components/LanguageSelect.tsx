import { Languages } from 'lucide-react';
import { Select } from './ui/select';
import { useLocale, tr } from '../lib/i18n';
export function LanguageSelect() {
  const { locale, setLocale } = useLocale();
  return (
    <div className="language-select">
      <Languages size={17} aria-hidden="true" />
      <Select
        aria-label={tr('语言', 'Language')}
        value={locale}
        onValueChange={(value) => setLocale(value === 'en' ? 'en' : 'zh')}
        options={[
          { value: 'zh', label: '中文' },
          { value: 'en', label: 'English' },
        ]}
      />
    </div>
  );
}
