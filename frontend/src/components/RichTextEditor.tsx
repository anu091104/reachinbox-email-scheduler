import TextAlign from '@tiptap/extension-text-align';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import clsx from 'clsx';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Heading,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
  type LucideIcon,
} from 'lucide-react';

interface Props {
  onChange: (html: string, isEmpty: boolean) => void;
}

export function RichTextEditor({ onChange }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: 'Type Your Reply...' }),
    ],
    onUpdate: ({ editor }) => onChange(editor.getHTML(), editor.isEmpty),
  });

  return (
    <div className="rounded-xl bg-surface">
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} className="px-4 pb-4" />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      heading: e.isActive('heading', { level: 2 }),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      code: e.isActive('codeBlock'),
      left: e.isActive({ textAlign: 'left' }),
      center: e.isActive({ textAlign: 'center' }),
      right: e.isActive({ textAlign: 'right' }),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });

  const c = () => editor.chain().focus();
  const groups: { icon: LucideIcon; label: string; active?: boolean; disabled?: boolean; run: () => void }[][] = [
    [
      { icon: Undo2, label: 'Undo', disabled: !s.canUndo, run: () => c().undo().run() },
      { icon: Redo2, label: 'Redo', disabled: !s.canRedo, run: () => c().redo().run() },
    ],
    [{ icon: Heading, label: 'Heading', active: s.heading, run: () => c().toggleHeading({ level: 2 }).run() }],
    [
      { icon: Bold, label: 'Bold', active: s.bold, run: () => c().toggleBold().run() },
      { icon: Italic, label: 'Italic', active: s.italic, run: () => c().toggleItalic().run() },
      { icon: Underline, label: 'Underline', active: s.underline, run: () => c().toggleUnderline().run() },
      { icon: Strikethrough, label: 'Strikethrough', active: s.strike, run: () => c().toggleStrike().run() },
    ],
    [
      { icon: AlignLeft, label: 'Align left', active: s.left, run: () => c().setTextAlign('left').run() },
      { icon: AlignCenter, label: 'Align center', active: s.center, run: () => c().setTextAlign('center').run() },
      { icon: AlignRight, label: 'Align right', active: s.right, run: () => c().setTextAlign('right').run() },
    ],
    [
      { icon: List, label: 'Bulleted list', active: s.bullet, run: () => c().toggleBulletList().run() },
      { icon: ListOrdered, label: 'Numbered list', active: s.ordered, run: () => c().toggleOrderedList().run() },
      { icon: Quote, label: 'Quote', active: s.quote, run: () => c().toggleBlockquote().run() },
      { icon: Code, label: 'Code block', active: s.code, run: () => c().toggleCodeBlock().run() },
    ],
  ];

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-line/80 px-3 py-2">
      {groups.map((g, gi) => (
        <div key={gi} className="flex items-center gap-0.5 border-r border-line/80 pr-1 last:border-r-0">
          {g.map(({ icon: Icon, label, active, disabled, run }) => (
            <button
              key={label}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={active}
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={run}
              className={clsx(
                'rounded p-1.5 text-muted transition hover:bg-white hover:text-ink disabled:opacity-30',
                active && 'bg-white text-ink shadow-sm',
              )}
            >
              <Icon size={15} />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
