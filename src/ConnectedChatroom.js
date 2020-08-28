// @flow
import React, { Component, } from "react";
import socketIOClient from "socket.io-client";
import type { ElementRef } from "react";

import type { ChatMessage, MessageType } from "./Chatroom";
import Chatroom from "./Chatroom";
import { sleep, uuidv4 } from "./utils";
import { ms } from "date-fns/locale";

type ConnectedChatroomProps = {
  userId: string,
  host: string,
  welcomeMessage: ?string,
  title: string,
  waitingTimeout: number,
  speechRecognition: ?string,
  messageBlacklist: Array<string>,
  handoffIntent: string,
  fetchOptions?: RequestOptions,
  voiceLang: ?string,
  isClientExternal: boolean,
  endpoint: string,
  idAttendant: ?string,
};
type ConnectedChatroomState = {
  messages: Array<ChatMessage>,
  messageQueue: Array<ChatMessage>,
  isOpen: boolean,
  waitingForBotResponse: boolean,
  currenthost: string,
  currenttitle: string,
  isClientExternal: boolean,
  endpoint: string,
  isTalkingToAttendant: boolean,
  idAttendant: string,
};

type RasaMessage =
  | {| sender_id: string, text: string |}
  | {|
  sender_id: string,
    buttons: Array < { title: string, payload: string, selected?: boolean } >,
      text ?: string
        |}
  | {| sender_id: string, image: string, text ?: string |}
  | {| sender_id: string, attachment: string, text ?: string |}
  | {| sender_id: string, custom: string, text ?: string |};

export default class ConnectedChatroom extends Component<
  ConnectedChatroomProps,
  ConnectedChatroomState
  > {

  state = {
    messages: [],
    messageQueue: [],
    isOpen: false,
    waitingForBotResponse: false,
    currenthost: `${this.props.host}`,
    currenttitle: `${this.props.title}`,
    idAttendant: undefined,
    endpoint: `${this.props.endpoint}`,
    isTalkingToAttendant: undefined,
    userId: '',
  };
  static defaultProps = {
    waitingTimeout: 5000,
    messageBlacklist: ["_restart", "_start", "/restart", "/start"],
    handoffIntent: "handoff"
  };
  handoffpayload = `\\/(${this.props.handoffIntent})\\b.*`;
  handoffregex = new RegExp(this.handoffpayload);
  waitingForBotResponseTimer: ?TimeoutID = null;
  messageQueueInterval: ?IntervalID = null;
  chatroomRef = React.createRef<Chatroom>();
  socket = undefined;
  
  componentDidMount() {
    const messageDelay = 800; //delay between message in ms
    this.messageQueueInterval = window.setInterval(
      this.queuedMessagesInterval,
      messageDelay
    );

    if (this.props.welcomeMessage && this.props.isClientExternal) {
      const welcomeMessage = {
        message: { type: "text", text: this.props.welcomeMessage },
        time: Date.now(),
        username: "bot",
        uuid: uuidv4()
      };
      this.setState({ messages: [welcomeMessage] });
    }
    const {endpoint, idAttendant} = this.state;
    this.startSocketOn(endpoint, idAttendant);
  }

  async startSocketOn(endpoint, idAttendant) {
    if (this.socket == undefined) {
      this.socket = socketIOClient(endpoint);      
    }
    if (this.socket) {
      let channel = idAttendant || this.props.idAttendant;
      if (channel != null) {
        this.socket.on(channel, (data) => {
          let msg = JSON.parse(data);
          if (msg.isClientExternal != this.props.isClientExternal) {          
            return this.sendMessageBetweenUserAttendant(msg);
          }
        });
      }
    }
  }
  
  componentWillUnmount() {
    if (this.waitingForBotResponseTimer != null) {
      window.clearTimeout(this.waitingForBotResponseTimer);
      this.waitingForBotResponseTimer = null;
    }
    if (this.messageQueueInterval != null) {
      window.clearInterval(this.messageQueueInterval);
      this.messageQueueInterval = null;
    }
  }

  sendMessageBetweenUserAttendant = async (msg) => {
    if (msg === "") return;
    const { isClientExternal } = this.props;
    const { isTalkingToAttendant } = this.state;
    const messageObj = isClientExternal && !isTalkingToAttendant ?
    {
      message: { type: "text", text: msg.message },
      time: Date.now(),
      username: msg.sender,
      uuid: uuidv4()
    } :
    this.createNewBotMessage({ type: "text", text: msg.message });
    if (!this.props.messageBlacklist.includes(msg.message) && !msg.message.match(this.handoffregex)) {
      let expandedMessages = [messageObj];
      // Bot messages should be displayed in a queued manner. Not all at once
      const messageQueue = [...this.state.messageQueue, ...expandedMessages];
      this.setState({
        messageQueue,
        waitingForBotResponse: messageQueue.length > 0
      });
    }

    if (msg.message.match(this.handoffregex)) {
      if (!isClientExternal) {
        this.setState({
          userId: msg.sender,
          currenttitle: msg.sender
        });
        this.sendMessage(this.props.welcomeMessage);
      } else {
        const {idAttendant} = this.state;
        this.socket.removeAllListeners(idAttendant);
        this.setState({
          isTalkingToAttendant: false,
          idAttendant: undefined,
          currenttitle: this.props.title
        });
        this.sendMessage(msg.message);
      }
    }
  }

  sendMessage = async (messageText: string) => {
    if (messageText === "") return;
    const { isTalkingToAttendant, idAttendant, endpoint} = this.state;
    const { isClientExternal} = this.props;
    if (isClientExternal) {
      const messageObj = {
        message: { type: "text", text: messageText },
        time: Date.now(),
        username: this.props.userId,
        uuid: uuidv4()
      };

      if (!this.props.messageBlacklist.includes(messageText) && !messageText.match(this.handoffregex)) {
        this.setState({
          // Reveal all queued bot messages when the user sends a new message
          messages: [
            ...this.state.messages,
            ...this.state.messageQueue,
            messageObj
          ],
          messageQueue: []
        });
      }

      this.setState({ waitingForBotResponse: true });
      if (this.waitingForBotResponseTimer != null) {
        window.clearTimeout(this.waitingForBotResponseTimer);
      }
      this.waitingForBotResponseTimer = setTimeout(() => {
        this.setState({ waitingForBotResponse: false });
      }, this.props.waitingTimeout);

      if (!isTalkingToAttendant) {
        const rasaMessageObj = {
          message: messageObj.message.text,
          sender: this.props.userId
        };

        const fetchOptions = Object.assign({}, {
          method: "POST",
          body: JSON.stringify(rasaMessageObj),
          headers: {
            "Content-Type": "application/json"
          }
        }, this.props.fetchOptions);

        const response = await fetch(
          `${this.state.currenthost}/webhooks/rest/webhook`,
          fetchOptions
        );
        const messages = await response.json();

        this.parseMessages(messages);

        if (window.ga != null) {
          window.ga("send", "event", "chat", "chat-message-sent");
        }
      } else {     
        // send message to attendant        
        const rasaMessageObj = {
          message: messageObj.message.text,
          sender: this.props.userId,
          output: idAttendant,
          isClientExternal: isClientExternal
        };
        if (this.socket) {
          this.socket.emit("xpto", JSON.stringify(rasaMessageObj));
        }
        // CLEAN UP THE EFFECT
        // return () => socket.disconnect();
      }
    } else {

      const messageObj = {
        message: { type: "text", text: messageText },        
        time: Date.now(),
        username: this.props.idAttendant,
        uuid: uuidv4()
      };

      if (!this.props.messageBlacklist.includes(messageText) && !messageText.match(this.handoffregex)) {
        let expandedMessages = [messageObj];
        // Bot messages should be displayed in a queued manner. Not all at once
        const messageQueue = [...this.state.messageQueue, ...expandedMessages];
        this.setState({
          messageQueue,
          waitingForBotResponse: messageQueue.length > 0
        });
      }

      // send message to user        
      const rasaMessageObj = {
        message: messageObj.message.text,
        sender: this.props.idAttendant,
        output: this.props.idAttendant,
        isClientExternal: isClientExternal
      };
      if (this.socket) {
        this.socket.emit("xpto", JSON.stringify(rasaMessageObj));
      }
      // CLEAN UP THE EFFECT
      // return () => socket.disconnect();

    }
  };

  createNewBotMessage(botMessageObj: MessageType): ChatMessage {
    return {
      message: botMessageObj,
      time: Date.now(),
      username: "bot",
      uuid: uuidv4()
    };
  }

  async parseMessages(RasaMessages: Array<RasaMessage>) {
    const validMessageTypes = ["text", "image", "buttons", "attachment", "custom"];

    let expandedMessages = [];

    RasaMessages.filter((message: RasaMessage) =>
      validMessageTypes.some(type => type in message)
    ).forEach((message: RasaMessage) => {
      let validMessage = false;
      if (message.text) {
        validMessage = true;
        expandedMessages.push(
          this.createNewBotMessage({ type: "text", text: message.text })
        );
      }

      if (message.buttons) {
        validMessage = true;
        expandedMessages.push(
          this.createNewBotMessage({ type: "button", buttons: message.buttons })
        );
      }

      if (message.image) {
        validMessage = true;
        expandedMessages.push(
          this.createNewBotMessage({ type: "image", image: message.image })
        );
      }

      // probably should be handled with special UI elements
      if (message.attachment) {
        validMessage = true;
        expandedMessages.push(
          this.createNewBotMessage({ type: "text", text: message.attachment })
        );
      }

      if (message.custom && message.custom.handoff_host) {
        validMessage = true;

        const isHttpRequest = message.custom.handoff_host.startsWith("http://") || message.custom.handoff_host.startsWith("https://");
        if (isHttpRequest) {
          this.setState({
            currenthost: message.custom.handoff_host
          });
          if (message.custom.title) {
            this.setState({
              currenttitle: message.custom.title,              
            })
          }
          this.sendMessage(`/${this.props.handoffIntent}{"from_host":"${this.props.host}"}`);
          return;
        } else {
          const {endpoint, idAttendant} = this.state;          
          if (idAttendant === undefined || idAttendant != message.custom.handoff_host) {
            this.setState({
              currenttitle: message.custom.title,
              isTalkingToAttendant: true,
              idAttendant: message.custom.handoff_host
            });
            this.startSocketOn(endpoint, message.custom.handoff_host);
          } else {
            this.setState({
              currenttitle: message.custom.title,
              isTalkingToAttendant: true,              
            });
          }
          this.sendMessage(`/${this.props.handoffIntent}{"from_host":"${this.props.host}"}`);
        }
      }

      if (validMessage === false)
        throw Error("Could not parse message from Bot or empty message");
    });

    // Bot messages should be displayed in a queued manner. Not all at once
    const messageQueue = [...this.state.messageQueue, ...expandedMessages];
    this.setState({
      messageQueue,
      waitingForBotResponse: messageQueue.length > 0
    });
  }

  queuedMessagesInterval = () => {
    const { messages, messageQueue } = this.state;

    if (messageQueue.length > 0) {
      const message = messageQueue.shift();
      const waitingForBotResponse = messageQueue.length > 0;

      this.setState({
        messages: [...messages, message],
        messageQueue,
        waitingForBotResponse
      });
    }
  };


  handleButtonClick = (buttonTitle: string, payload: string) => {
    this.sendMessage(payload);
    if (window.ga != null) {
      window.ga("send", "event", "chat", "chat-button-click");
    }
  };

  handleToggleChat = () => {
    if (window.ga != null) {
      if (this.state.isOpen) {
        window.ga("send", "event", "chat", "chat-close");
      } else {
        window.ga("send", "event", "chat", "chat-open");
      }
    }
    this.setState({ isOpen: !this.state.isOpen });
  };

  render() {
    const { messages, waitingForBotResponse } = this.state;

    const renderableMessages = messages
      .filter(
        message =>
          message.message.type !== "text" || (
          !this.props.messageBlacklist.includes(message.message.text) &&
          !message.message.text.match(this.handoffregex) )
      )
      .sort((a, b) => a.time - b.time);

    return (
      <Chatroom
        messages={renderableMessages}
        title={this.state.currenttitle}
        waitingForBotResponse={waitingForBotResponse}
        isOpen={this.state.isOpen}
        speechRecognition={this.props.speechRecognition}
        onToggleChat={this.handleToggleChat}
        onButtonClick={this.handleButtonClick}
        onSendMessage={this.sendMessage}
        ref={this.chatroomRef}
        voiceLang={this.props.voiceLang}
        host={this.state.currenthost}
      />
    );
  }
}
