import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import {
  developmentBackendUrl,
  loadVars,
  useVariables,
  VariableContextComponent,
} from '@gitroom/react/helpers/variable.context';

// The backend the browser uses in development (VariableContextComponent of
// the shared react library): the frontend dev server can be opened as
// localhost, 127.0.0.1 or the LAN address, and each must reach the backend on
// that same host. A .spec.ts without JSX, like the other frontend specs
const LAN = 'http://192.168.1.201';

describe('developmentBackendUrl', () => {
  it('HOST1 a page opened on localhost uses the backend on localhost', () => {
    expect(
      developmentBackendUrl(
        `${LAN}:3000`,
        `${LAN}:4200`,
        'development',
        'localhost'
      )
    ).toBe('http://localhost:3000');
  });

  it('HOST2 a page opened on 127.0.0.1 uses the backend on 127.0.0.1', () => {
    expect(
      developmentBackendUrl(
        `${LAN}:3000`,
        `${LAN}:4200`,
        'development',
        '127.0.0.1'
      )
    ).toBe('http://127.0.0.1:3000');
  });

  it('HOST3 a page opened on the LAN address keeps the configured backend', () => {
    expect(
      developmentBackendUrl(
        `${LAN}:3000`,
        `${LAN}:4200`,
        'development',
        '192.168.1.201'
      )
    ).toBe(`${LAN}:3000`);
  });

  it('HOST4 production never derives the backend from the browser', () => {
    for (const environment of ['production', 'test', '']) {
      expect(
        developmentBackendUrl(
          'https://api.example.com',
          'https://app.example.com',
          environment,
          'localhost'
        )
      ).toBe('https://api.example.com');
    }
  });

  it('HOST6 on the server, and for a backend on another host, the configured URL stays', () => {
    expect(
      developmentBackendUrl(`${LAN}:3000`, `${LAN}:4200`, 'development')
    ).toBe(`${LAN}:3000`);
    expect(
      developmentBackendUrl(
        'https://api.example.com',
        `${LAN}:4200`,
        'development',
        'localhost'
      )
    ).toBe('https://api.example.com');
    // nothing to compare with: kept as it is
    expect(
      developmentBackendUrl(`${LAN}:3000`, '', 'development', 'localhost')
    ).toBe(`${LAN}:3000`);
  });

  it('keeps the protocol, port and path of the backend, and its trailing slash or none', () => {
    expect(
      developmentBackendUrl(
        `${LAN}:3000/api`,
        `${LAN}:4200`,
        'development',
        'localhost'
      )
    ).toBe('http://localhost:3000/api');
    expect(
      developmentBackendUrl(
        `${LAN}:3000/`,
        `${LAN}:4200`,
        'development',
        'localhost'
      )
    ).toBe('http://localhost:3000/');
  });
});

describe('VariableContextComponent: the backend in the browser', () => {
  afterEach(cleanup);

  const Copilot = () => {
    const { backendUrl } = useVariables();
    // what the layouts hand CopilotKit as its runtime URL
    return h(
      'span',
      { 'data-testid': 'runtime' },
      `${backendUrl}/copilot/chat`
    );
  };
  const show = (environment: string) =>
    render(
      h(
        VariableContextComponent,
        {
          environment,
          backendUrl: `${LAN}:3000`,
          frontEndUrl: `${LAN}:4200`,
        } as never,
        h(Copilot)
      )
    );

  it('HOST1/HOST5 in development every consumer, CopilotKit included, gets the backend on the browser host', () => {
    // jsdom serves the page from localhost
    expect(window.location.hostname).toBe('localhost');
    show('development');
    expect(screen.getByTestId('runtime').textContent).toBe(
      'http://localhost:3000/copilot/chat'
    );
    expect(loadVars().backendUrl).toBe('http://localhost:3000');
  });

  it('HOST4 in production the configured backend is handed on unchanged', () => {
    show('production');
    expect(screen.getByTestId('runtime').textContent).toBe(
      `${LAN}:3000/copilot/chat`
    );
    expect(loadVars().backendUrl).toBe(`${LAN}:3000`);
  });
});
