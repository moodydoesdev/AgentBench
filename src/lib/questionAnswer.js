// Claude 2.1's picker advances to a review page except for one single-select
// question. Keep individual key events separate so React can update selection.
const DOWN = "\x1b[B";
const ENTER = "\r";
export function questionAnswerSteps(questions, answers) {
  const steps = [];
  questions.forEach((q, i) => {
    const answer = answers[i];
    const down = (count) => { for (let n = 0; n < count; n++) steps.push(DOWN); };
    if (answer.other.trim()) {
      down(q.options.length);
      // Other is an inline input: focusing it already enters text mode.
      // Enter before the paste would submit an empty answer / advance early.
      steps.push(`\x1b[200~${answer.other.trim()}\x1b[201~`, ENTER);
    } else if (q.multiSelect) {
      let position = 0;
      for (const index of [...answer.set].sort((a, b) => a - b)) {
        down(index - position);
        steps.push(" ");
        position = index;
      }
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
