/**
 * What the page you are on can do, for Find's Actions (⌘K): the open note's "Make a project"
 * (N2). A page hands its actions in while it is on screen and takes them back when it goes;
 * Find reads them when it opens and lists them first among the actions. One page at a time:
 * the last to hand them in is the page in view.
 */
import { useLayoutEffect } from "react";

export interface PageAction {
  id: string;
  title: string;
  meta: string;
  icon: string;
  /** More words it answers to. */
  words: string;
  run: () => void;
}

let current: readonly PageAction[] = [];

/** The actions of the page in view, as it handed them in. */
export const pageActions = (): readonly PageAction[] => current;

/** Hand the page's actions to Find while this component is on screen. Pass a memoised list. */
export function usePageActions(list: readonly PageAction[]): void {
  useLayoutEffect(() => {
    current = list;
    return () => {
      if (current === list) current = [];
    };
  }, [list]);
}
