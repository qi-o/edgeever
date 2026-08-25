import type { EditorState, Transaction } from "@tiptap/pm/state";

const TAB_DELEGATED_NODE_TYPES = new Set([
  "listItem",
  "taskItem",
  "tableCell",
  "tableHeader",
]);

const hasDelegatedTabAncestor = (state: EditorState, position: number) => {
  const resolved = state.doc.resolve(position);
  for (let depth = resolved.depth; depth >= 0; depth -= 1) {
    if (TAB_DELEGATED_NODE_TYPES.has(resolved.node(depth).type.name)) {
      return true;
    }
  }
  return false;
};

const selectedTextBlockStarts = (state: EditorState) => {
  const { from, to } = state.selection;
  const starts: number[] = [];
  const rangeEnd = Math.max(from, to - 1);

  state.doc.nodesBetween(from, rangeEnd, (node, position) => {
    if (!node.isTextblock) {
      return true;
    }
    starts.push(position + 1);
    return false;
  });

  return starts;
};

/**
 * Handles Tab as text indentation while leaving structural contexts to
 * Tiptap's list and table keymaps.
 */
export const applyPlainTextTab = (
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  shiftKey = false,
) => {
  const { selection } = state;
  if (
    !selection.$from.parent.isTextblock
    || !selection.$to.parent.isTextblock
    || hasDelegatedTabAncestor(state, selection.from)
    || hasDelegatedTabAncestor(state, selection.to)
  ) {
    return false;
  }

  if (!dispatch) {
    return true;
  }

  if (selection.empty) {
    if (!shiftKey) {
      dispatch(state.tr.insertText("\t", selection.from));
      return true;
    }

    const blockStart = selection.$from.start();
    const precedingCharacter = selection.from > blockStart
      ? state.doc.textBetween(selection.from - 1, selection.from)
      : "";
    if (precedingCharacter === "\t") {
      dispatch(state.tr.delete(selection.from - 1, selection.from));
      return true;
    }

    if (state.doc.textBetween(blockStart, blockStart + 1) === "\t") {
      dispatch(state.tr.delete(blockStart, blockStart + 1));
    }
    return true;
  }

  const blockStarts = selectedTextBlockStarts(state);
  if (blockStarts.some((position) => hasDelegatedTabAncestor(state, position))) {
    return false;
  }

  const transaction = state.tr;
  for (const position of blockStarts.reverse()) {
    if (shiftKey) {
      if (state.doc.textBetween(position, position + 1) === "\t") {
        transaction.delete(position, position + 1);
      }
    } else {
      transaction.insertText("\t", position);
    }
  }
  dispatch(transaction);
  return true;
};

export const saveAndSyncEditor = async ({
  hasUnsavedChanges,
  save,
  sync,
}: {
  hasUnsavedChanges: boolean;
  save: () => Promise<unknown>;
  sync: () => Promise<unknown>;
}) => {
  if (hasUnsavedChanges) {
    await save();
  }

  await sync();
};

export const getAiSlashCommandStart = ({
  caretPosition,
  insertedText,
  textBefore,
}: {
  caretPosition: number;
  insertedText: string;
  textBefore: string;
}) => {
  if (insertedText.toLowerCase() !== "i" || !/(?:^|\s)\/a$/i.test(textBefore)) {
    return null;
  }

  return caretPosition - 2;
};

export const shouldOpenAiFromSpace = ({
  altKey,
  ctrlKey,
  isComposing,
  isEmptyParagraph,
  key,
  keyCode,
  metaKey,
  repeat,
  selectionEmpty,
  shiftKey,
}: {
  altKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  isEmptyParagraph: boolean;
  key: string;
  keyCode: number;
  metaKey: boolean;
  repeat: boolean;
  selectionEmpty: boolean;
  shiftKey: boolean;
}) => key === " "
  && !altKey
  && !ctrlKey
  && !metaKey
  && !shiftKey
  && !repeat
  && !isComposing
  && keyCode !== 229
  && selectionEmpty
  && isEmptyParagraph;
