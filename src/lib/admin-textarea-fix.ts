// Shared cursor / selection-sync fix for pre-filled multi-line textareas
// rendered inside the Shopify embedded admin iframe.
//
// Bug: in the Shopify embedded admin (App Bridge iframe context), the FIRST
// keystroke after page load on any pre-filled textarea is inserted at
// position (0,0) regardless of where the visible cursor was — most likely
// an App Bridge focus race that hands the textarea an out-of-sync selection
// model. Subsequent keystrokes are fine.
//
// The fix: catch the first `input` event, compare what actually landed
// against (a) what should have landed if the insert respected the saved
// cursor position, and (b) what would have landed if the bug pattern fired
// (insert at position 0). When the bug pattern matches, splice the
// character to the right place and resync `selectionStart` / `selectionEnd`.
//
// Lighter approaches (mouseup setSelectionRange, requestAnimationFrame
// nudge) did NOT work — by the time `input` fires the bug has already
// committed. This is the minimum that reliably catches the misfire.
//
// Also strips autocomplete / autocorrect / autocapitalize / spellcheck on
// these textareas — they were observed to interfere with selection state.

export const renderTextareaCursorFixScript = (selector: string): string => `
  <script>
    document.addEventListener('DOMContentLoaded', function () {
      document.querySelectorAll(${JSON.stringify(selector)}).forEach(function (ta) {
        ta.setAttribute('autocomplete', 'off');
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('autocapitalize', 'off');
        ta.setAttribute('spellcheck', 'false');

        var firstInputDone = false;
        var savedSelection = null;
        var prevValue = ta.value;

        var saveSelection = function () {
          savedSelection = { start: ta.selectionStart, end: ta.selectionEnd };
        };
        ta.addEventListener('mouseup', function () { setTimeout(saveSelection, 0); });
        ta.addEventListener('keyup', function () { setTimeout(saveSelection, 0); });
        ta.addEventListener('focus', function () { setTimeout(saveSelection, 0); });

        ta.addEventListener('input', function (e) {
          var thisIsFirstInput = !firstInputDone;
          firstInputDone = true;

          if (thisIsFirstInput &&
              e.inputType === 'insertText' &&
              e.data &&
              savedSelection &&
              savedSelection.start > 0) {
            var expectedPos = savedSelection.start;
            var insertedChar = e.data;
            var expectedValue = prevValue.substring(0, expectedPos) + insertedChar + prevValue.substring(expectedPos);
            var actualValue = ta.value;
            var bugValue = insertedChar + prevValue;

            if (actualValue !== expectedValue && actualValue === bugValue) {
              ta.value = expectedValue;
              ta.setSelectionRange(expectedPos + 1, expectedPos + 1);
              savedSelection = { start: expectedPos + 1, end: expectedPos + 1 };
            }
          }
          prevValue = ta.value;
        });
      });
    });
  </script>
`;

// CSS hardening for textareas that have to render correctly in the Shopify
// embedded admin: drop any `filter` (a known cursor desync trigger, hit
// originally on the profanity wordlist), drop transforms, force a relative
// position so the input layer aligns with the visible cursor, and use a
// stable font stack so glyph metrics don't drift between platforms.
export const ADMIN_TEXTAREA_FIX_CSS = `
  filter: none !important;
  transform: none !important;
  position: relative;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  line-height: 1.5;
`;
