import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import type { ComponentProps } from 'react';
import '../../styles/select.css';

interface SelectProps
  extends Pick<
    ComponentProps<typeof SelectPrimitive.Trigger>,
    'id' | 'aria-label' | 'aria-labelledby' | 'aria-describedby'
  > {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  name?: string;
  className?: string;
  size?: 'sm' | 'default';
}

export function Select({
  value,
  onValueChange,
  options,
  disabled,
  name,
  className,
  size = 'default',
  ...labelProps
}: SelectProps) {
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      name={name}
    >
      <SelectPrimitive.Trigger
        {...labelProps}
        className={['select-trigger', size === 'sm' && 'select-trigger-sm', className]
          .filter(Boolean)
          .join(' ')}
      >
        <span className="select-value">
          <SelectPrimitive.Value />
        </span>
        <SelectPrimitive.Icon className="select-chevron">
          <ChevronDown size={16} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="select-content"
          aria-label={labelProps['aria-label']}
          aria-labelledby={labelProps['aria-labelledby']}
          position="popper"
          align="start"
          sideOffset={6}
          collisionPadding={12}
        >
          <SelectPrimitive.ScrollUpButton className="select-scroll-button">
            <ChevronUp size={16} />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="select-viewport">
            {options.map((option) => (
              <SelectPrimitive.Item
                className="select-option"
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="select-check">
                  <Check size={12} strokeWidth={3} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="select-scroll-button">
            <ChevronDown size={16} />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
