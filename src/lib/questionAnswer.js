// Claude 2.1's picker advances to a review page except for one single-select
// question. Keep individual key events separate so React can update selection.
//
// Multi-select rows are options, "Type something", then a Submit row. Enter on
// an option or the text row *toggles* it (it does not advance), so a trailing
// Enter there unchecks the last pick and leaves the picker stuck. Advance by
// walking down to Submit and pressing Enter on that.
const DOWN = "\x1b[B";
const ENTER = "\r";
export function questionAnswerSteps(questions, answers) {
  const steps = [];
  questions.forEach((q, i) => {
    const answer = answers[i];
    const down = (count) => { for (let n = 0; n < count; n++) steps.push(DOWN); };
    const paste = (text) => steps.push(`\x1b[200~${text}\x1b[201~`);
    if (q.multiSelect) {
      let position = 0;
      for (const index of [...answer.set].sort((a, b) => a - b)) {
        down(index - position);
        steps.push(" ");
        position = index;
      }
      if (answer.other.trim()) {
        // typing into the text row checks it
        down(q.options.length - position);
        paste(answer.other.trim());
        position = q.options.length;
      }
      down(q.options.length + 1 - position);
      steps.push(ENTER);
    } else if (answer.other.trim()) {
      down(q.options.length);
      // Other is an inline input: focusing it already enters text mode.
      // Enter before the paste would submit an empty answer / advance early.
      paste(answer.other.trim());
      steps.push(ENTER);
    } else {
      down(answer.pick ?? 0);
      steps.push(ENTER);
    }
  });
  if (questions.length > 1 || questions[0]?.multiSelect) steps.push(ENTER);
  return steps;
}

export async function sendQuestionAnswer(invoke, paneId, steps, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  for (let i = 0; i < steps.length; i++) {
    await invoke("write_pane", { id: paneId, data: steps[i], ack: true, answers: i === 0 });
    await wait(200);
  }
}
