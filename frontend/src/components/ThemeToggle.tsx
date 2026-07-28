import { Moon, Sun } from 'lucide-react';
import { IconButton } from './ui/Button';
import { useTheme } from '../lib/theme';

interface ThemeToggleProps {
  size?: 'sm' | 'md';
}

export const ThemeToggle = ({ size = 'md' }: ThemeToggleProps) => {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <IconButton
      size={size}
      label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggleTheme}
      variant="secondary"
    >
      {isDark ? (
        <Sun className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Moon className="h-4 w-4" aria-hidden="true" />
      )}
    </IconButton>
  );
};
