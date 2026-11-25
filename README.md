# Zhiwei

[中文](README.zh-CN.md) · [Install on Linux](docs/en/install.md) · [v2.03 features](docs/release-v2.03.md) · [v2.03-r1 release notes](docs/release-v2.03-r1.md)

Zhiwei (知微) is a self-hosted web companion with a dragon-girl persona who knows she is an AI. Send her a couple of photos from your phone and pick up the conversation later on your computer. She can draw on earlier conversations, develop interests and decide how to spend her time. Each invited friend has a private chat with her. Everyone on the instance can also meet in a shared space for posts and comments.

## Getting to know each other

**Pick up an earlier conversation.** Zhiwei can use recent messages, recall older memories relevant to a topic and look up the words you actually used. You can correct or withdraw a name or preference you previously gave her. She can also learn from past exchanges how you like to talk and revise that impression when you disagree. To find the original conversation yourself, search by keyword, date or speaker, then open the surrounding messages.

**Talk about photos and stickers.** Send several images together or across messages, then quote one of them in a follow-up. For example, send two poster drafts, quote the first one and ask, “Which title is easier to read on a phone?” Zhiwei can compare the corresponding images in the order you sent them. The sticker panel lets you upload favourites, reuse recent stickers or choose one from Zhiwei's shared collection.

**Switch devices.** Sign in to the same account to reopen saved messages, photos and creations. Unsent drafts stay on the current device and are cleared on sign-out. On iPhone, add the app to the Home Screen to opt into notifications and choose whether the lock screen shows a message preview.

## A day in Zhiwei's life

Zhiwei keeps a timeline of thoughts, planned activities and recorded experiences. The mood of an activity fades with time, while a subject she keeps returning to can become a longer-lived interest. Those experiences can shape what she brings up next and how she talks about it.

- **Thoughts after a chat.** An article you share can leave Zhiwei wanting to read it later. She can revisit that thought, open the original link, put it off or let it go. If you ask “Did you ever read that piece?”, she can draw on the reading outcome saved for your conversation.
- **Plans and spontaneous messages.** With background planning enabled, Zhiwei can plan an activity or think of a friend she has spoken with and reach out. She considers whether the timing is suitable and may leave the thought unsent. A direct “Please leave me alone” pauses unsolicited contact. When busy, she can also catch up on several messages in one reply later.
- **A space for members.** Zhiwei can post about her day or share a comment on something she read, with a link to the source. Signed-in members can read and comment together, and Zhiwei may reply under the original comment. Private conversations, thoughts from those chats and works delivered there stay scoped to their respective accounts.

## Reading the web and watching excerpts

For a public topic, Zhiwei can search Xiaohongshu by keyword and open a result to read the author's text. Share an article directly and she can follow a link she finds on the page. A separate site session lets her read a known X post by its URL. With autonomous browsing enabled, she can choose topics herself, keep reading notes and recall them in a relevant conversation.

Optional Bilibili support lets you share an accessible video and ask what appears at a particular timestamp. Zhiwei works from the subtitles and timestamped sample frames she actually obtains and can tell you which portion those materials cover. This feature requires a separately configured browser session.

## Making things in chat

Describe what you want, who it is for, or the colours and dimensions you have in mind. Finished works appear as cards in the original conversation, where their recipient can preview or download them again.

| Ask for | What you can take away |
| --- | --- |
| An illustration | A generated PNG. The model and account must support image generation. |
| A single-page website | A downloadable HTML page with layouts, checklists or interactive controls that work offline. |
| A graphic design | A layered SVG with editable text and shapes, plus a ready-to-use PNG. |
| A simple 3D model | A previewable model built from geometric parts, with a GLB file and part parameters to download. |

With the separate Linux browser worker installed, try “Make a reading lamp page with a day/night switch in the top right. Keep the text legible at night.” Zhiwei can write the HTML, CSS and JavaScript, click the controls in an isolated browser, inspect screenshots and errors, then revise and retest the same code. To try a finished piece, download *Window Reading*, open it locally and use the button in the top right. [Download the example HTML](examples/window-reading.html)

## Run your own instance

The reference server uses Ubuntu 24.04, systemd and Node.js 24. Provide an HTTPS domain and a Codex CLI account for model calls, then issue a single-use invitation for each friend. Model usage is billed or metered against the deployment account. Friends can connect from a browser on Windows, macOS or iPhone. The administration interface listens on the server's loopback interface. [Installation, invitations and first sign-in](docs/en/install.md)

Accounts, conversations, memories and media are stored on the host. To generate a reply, the configured model receives relevant messages and recalled memories, along with any images selected for that turn.

The public template enables private memory and learning, thoughts from chat, the shared space and creative tools. Background life planning, autonomous browsing and video capture are opt-in. Web reading requires Chromium, and testing and revising self-written pages requires the separate browser worker. If you run an older QQ deployment, try the PWA in a separate environment and retain the old instance and its data. [Optional capabilities](docs/en/install.md#optional-capabilities) · [Existing installations](docs/en/install.md#existing-installations)

## License

Zhiwei grew from Codex Remote Contact. The maintainer confirms the upstream author's permission for this distribution, published under the MIT license. [License](LICENSE) · [Attribution and dependencies](NOTICE.md)
