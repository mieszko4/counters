curl --request GET http://localhost:3001/v2/polls/YourLanguage/params/test2

curl --header "Content-Type: application/json" --request POST --data '{"paramName":"testM","paramValue":"estr"}' http://localhost:3001/v2/polls/YourLanguage/params

curl --request DELETE http://localhost:3001/v2/polls/YourLanguage/params/test2