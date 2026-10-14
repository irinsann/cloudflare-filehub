import { Slot } from '@radix-ui/react-slot';
import type { ButtonHTMLAttributes } from 'react';
const variants = {
  default: 'button-primary',
  outline: 'button-outline',
  ghost: 'button-ghost',
  danger: 'button-danger',
} as const;
const sizes = { default: '', sm: 'button-sm', icon: 'button-icon' } as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
};

export function Button({
  asChild = false,
  variant = 'default',
  size = 'default',
  className,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  const classes = ['button', variants[variant], sizes[size], className].filter(Boolean).join(' ');
  return <Comp className={classes} {...props} />;
}
