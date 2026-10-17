// Shared Markdown rendering for chart analysis. Only code highlighting is needed.
import { cn } from '@/lib/utils'
import { code } from '@streamdown/code'
import { memo, type ComponentProps } from 'react'
import { Streamdown } from 'streamdown'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const streamdownPlugins = { code };
const markdownComponents: MessageResponseProps['components'] = {
  table: ({ node: _node, ...props }) => <Table {...props} />,
  thead: ({ node: _node, ...props }) => <TableHeader {...props} />,
  tbody: ({ node: _node, ...props }) => <TableBody {...props} />,
  tr: ({ node: _node, ...props }) => <TableRow {...props} />,
  th: ({ node: _node, ...props }) => <TableHead {...props} className="whitespace-normal" />,
  td: ({ node: _node, ...props }) => <TableCell {...props} className="whitespace-normal" />,
};

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
      plugins={streamdownPlugins}
      components={markdownComponents}
      linkSafety={{ enabled: false }}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating
);

MessageResponse.displayName = "MessageResponse";

