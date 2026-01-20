#ifndef MISSKEY_WEBSOCKET
#define MISSKEY_WEBSOCKET

#include <iostream>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXUserAgent.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace Misskey {
    class websocket {
        public:
            void connect(std::string uri, std::string token) {
                ix::initNetSystem();
                std::cout << "notting to do" << std::endl;

                std::string url = "wss://" + uri + "/streaming?i=" + token;
                ws.setUrl(url);
                ws.enableAutomaticReconnection();

                std::cout << "Connecting to " << "wss://" << uri << "/streaming..." << std::endl;

                ws.setOnMessageCallback(std::bind(&websocket::onMessage, this, std::placeholders::_1));
                ws.start();

                while (true) {
                    // loop
                }
            }

        private:
            ix::WebSocket ws;

            void onMessage(const ix::WebSocketMessagePtr& msg) {
                json data;

                switch (msg->type)
                {
                    case ix::WebSocketMessageType::Message:
                        std::cout << "received message: " << msg->str << std::endl;
                        break;

                    case ix::WebSocketMessageType::Open:
                        std::cout << "Connection established" << std::endl;

                        data["type"] = "connect";
                        data["body"]["channel"] = "hybridTimeline";
                        data["body"]["id"] = "social";

                        ws.send(data.dump().c_str());
                        break;

                    case ix::WebSocketMessageType::Error:
                        std::cout << "Connection error: " << msg->errorInfo.reason << std::endl;
                        break;
                    
                    default:
                        break;
                }
            }
    };
}

#endif MISSKEY_WEBSOCKET
