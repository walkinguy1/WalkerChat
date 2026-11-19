// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewChatDialog } from '../NewChatDialog';

afterEach(cleanup);

const profile = (id: string, username: string) => ({
  id, username, display_name: username, initials: username.slice(0, 1).toUpperCase(), presence_state: 'offline' as const,
});

describe('contact discovery', () => {
  it('lets users request a contact and accept incoming requests', async () => {
    const user = userEvent.setup();
    const onRequestContact = vi.fn(async () => undefined);
    const onRespondContact = vi.fn(async () => undefined);
    const onBlockContact = vi.fn(async () => undefined);
    const onUnblockContact = vi.fn(async () => undefined);
    const onRemoveContact = vi.fn(async () => undefined);
    const onLoadContacts = vi.fn(async () => ({
      contacts: [],
      blocked: [],
      requests: [{ id: 'request-1', direction: 'incoming' as const, user: profile('peer-2', 'peer_two') }],
    }));
    render(<NewChatDialog open onClose={vi.fn()} onSearch={async () => [profile('peer-1', 'peer_one')]} onLoadContacts={onLoadContacts} onRequestContact={onRequestContact} onRespondContact={onRespondContact} onBlockContact={onBlockContact} onUnblockContact={onUnblockContact} onRemoveContact={onRemoveContact} onCreate={vi.fn()} />);
    await screen.findByText('peer_two · @peer_two');
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(onRespondContact).toHaveBeenCalledWith('request-1', 'accept');

    await user.type(screen.getByLabelText('Search by username'), 'peer');
    await screen.findByText('@peer_one');
    await user.click(screen.getByRole('button', { name: 'Request' }));
    await waitFor(() => expect(onRequestContact).toHaveBeenCalledWith('peer-1'));
  });

  it('does not allow starting a chat before contact acceptance', async () => {
    const user = userEvent.setup();
    render(<NewChatDialog open onClose={vi.fn()} onSearch={async () => [profile('peer-1', 'peer_one')]} onLoadContacts={async () => ({ contacts: [], requests: [], blocked: [] })} onRequestContact={vi.fn()} onRespondContact={vi.fn()} onBlockContact={vi.fn()} onUnblockContact={vi.fn()} onRemoveContact={vi.fn()} onCreate={vi.fn()} />);
    await user.type(screen.getByLabelText('Search by username'), 'peer');
    await screen.findByRole('button', { name: 'Request' });
    expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(true);
  });
});
