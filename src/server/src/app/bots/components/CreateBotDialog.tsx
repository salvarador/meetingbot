"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Plus } from "lucide-react";
import { api } from "~/trpc/react";
import { toast } from "sonner";

export function CreateBotDialog() {
  const [open, setOpen] = useState(false);
  const [meetingUrl, setMeetingUrl] = useState("");
  const [botDisplayName, setBotDisplayName] = useState("Railway Bot");

  const utils = api.useUtils();
  const createBot = api.bots.createBot.useMutation({
    onSuccess: () => {
      toast.success("Bot queued successfully!");
      setOpen(false);
      setMeetingUrl("");
      void utils.bots.getBots.invalidate();
    },
    onError: (error) => {
      toast.error(`Error: ${error.message}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Simple validation to extract platform from URL
    let platform: "google" | "zoom" | "teams" | undefined = undefined;
    if (meetingUrl.includes("meet.google.com")) platform = "google";
    else if (meetingUrl.includes("zoom.us")) platform = "zoom";
    else if (meetingUrl.includes("teams.microsoft.com")) platform = "teams";

    if (!platform) {
      toast.error("Unsupported meeting URL platform");
      return;
    }

    createBot.mutate({
      botDisplayName,
      meetingTitle: "Test Meeting",
      meetingInfo: {
        url: meetingUrl,
        platform,
      },
      // Other fields will use defaults from the router
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" /> Deploy Test Bot
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deploy a New Bot</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="url">Meeting URL</Label>
            <Input
              id="url"
              placeholder="https://meet.google.com/..."
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="name">Bot Display Name</Label>
            <Input
              id="name"
              placeholder="Railway Bot"
              value={botDisplayName}
              onChange={(e) => setBotDisplayName(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={createBot.isLoading}>
              {createBot.isLoading ? "Deploying..." : "Deploy Now"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
