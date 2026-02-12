#ifndef MISSKEY_WEBSOCKET
#define MISSKEY_WEBSOCKET

#include <iostream>
#include <thread>
#include <chrono>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXUserAgent.h>
#include <nlohmann/json.hpp>
#include "event_handler.hpp"

using json = nlohmann::json;

namespace Misskey {
    class websocket {
        public:
            EventHandler& handler;

            explicit websocket(EventHandler& h) : handler(h) {}

            void connect(std::string uri, std::string token) {
                ix::initNetSystem();

                connected_uri = uri;

                std::string url = "wss://" + uri + "/streaming?i=" + token;
                ws.setUrl(url);
                ws.enableAutomaticReconnection();

                ws.setOnMessageCallback(std::bind(&websocket::onMessage, this, std::placeholders::_1));
                ws.start();

                // Keep alive with a sleep to avoid busy-wait
                while (true) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                }
            }

        private:
            ix::WebSocket ws;
            std::string connected_uri;

            void onMessage(const ix::WebSocketMessagePtr& msg) {
                switch (msg->type)
                {
                    case ix::WebSocketMessageType::Message:
                        handler.handle(msg->str);
                        break;

                    case ix::WebSocketMessageType::Open:
                        onWsOpen();
                        break;

                    case ix::WebSocketMessageType::Close:
                        handler.emit_disconnected(msg->closeInfo.reason);
                        break;

                    case ix::WebSocketMessageType::Error:
                        handler.emit_error("ws_error", msg->errorInfo.reason);
                        break;
                    
                    default:
                        break;
                }
            }

            void onWsOpen() {
                handler.emit_connected(connected_uri);

                json data;
                data["type"] = "connect";
                data["body"]["channel"] = "main";
                data["body"]["id"] = "main";
                ws.send(data.dump().c_str());

                data.clear();
                data["type"] = "connect";
                data["body"]["channel"] = "hybridTimeline";
                data["body"]["id"] = "social";
                ws.send(data.dump().c_str());
            }
    };
}

#endif // MISSKEY_WEBSOCKET
