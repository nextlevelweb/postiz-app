// Proves the jsdom project runs; no application code involved
describe('unit test setup (jsdom)', () => {
  it('provides a DOM', () => {
    const node = document.createElement('div');
    node.textContent = 'ok';
    document.body.appendChild(node);

    expect(document.body.textContent).toBe('ok');

    node.remove();
  });
});
