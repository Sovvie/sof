--!strict
--[[
	SpriteSheetPlayer

	Reads the generated manifest module and creates a playable spritesheet
	animation on a Part in Workspace, scaled to the first spritesheet's
	pixel dimensions.

	Usage:
	  1. Place this Script alongside your manifest ModuleScript
	  2. Adjust the require path below to point at your manifest
	  3. Run the game — the Part appears in Workspace with the animation playing
]]

local RunService = game:GetService("RunService")

local Manifest = require(script.Parent.manifest)

local PIXELS_PER_STUD = 100

type SheetEntry = {
	asset: string | number,
	width: number,
	height: number,
}

type FrameEntry = {
	sheet: number,
	x: number,
	y: number,
	w: number,
	h: number,
}

type Animation = {
	frameCount: number,
	fps: number,
	frames: { FrameEntry },
}

local function getFirstAnimation(): (string, Animation)
	for name, anim in Manifest.animations do
		return name, anim :: Animation
	end
	error("[SpriteSheetPlayer] No animations found in manifest")
end

local function createDisplay(animName: string, anim: Animation): (Part, ImageLabel)
	local firstFrame = anim.frames[1]
	local sheet: SheetEntry = Manifest.sheets[firstFrame.sheet]

	local studsW = sheet.width / PIXELS_PER_STUD
	local studsH = sheet.height / PIXELS_PER_STUD

	local part = Instance.new("Part")
	part.Name = "SpriteSheet_" .. animName
	part.Anchored = true
	part.CanCollide = false
	part.Size = Vector3.new(studsW, studsH, 0.05)
	part.Position = Vector3.new(0, studsH / 2 + 2, -5)
	part.Color = Color3.new(0, 0, 0)

	local gui = Instance.new("SurfaceGui")
	gui.Name = "SpriteGui"
	gui.Face = Enum.NormalId.Front
	gui.SizingMode = Enum.SurfaceGuiSizingMode.FixedSize
	gui.CanvasSize = Vector2.new(firstFrame.w, firstFrame.h)
	gui.LightInfluence = 0
	gui.Parent = part

	local img = Instance.new("ImageLabel")
	img.Name = "SpriteFrame"
	img.Size = UDim2.fromScale(1, 1)
	img.BackgroundTransparency = 1
	img.ScaleType = Enum.ScaleType.Stretch

	if type(sheet.asset) == "string" then
		img.Image = sheet.asset
	end

	img.ImageRectOffset = Vector2.new(firstFrame.x, firstFrame.y)
	img.ImageRectSize = Vector2.new(firstFrame.w, firstFrame.h)
	img.Parent = gui

	part.Parent = workspace

	return part, img
end

local function playAnimation(img: ImageLabel, anim: Animation): RBXScriptConnection
	local frameIdx = 1
	local elapsed = 0
	local interval = 1 / anim.fps
	local currentSheet = anim.frames[1].sheet

	return RunService.Heartbeat:Connect(function(dt: number)
		elapsed += dt
		if elapsed < interval then
			return
		end
		elapsed -= interval

		frameIdx = (frameIdx % anim.frameCount) + 1
		local frame = anim.frames[frameIdx]

		if frame.sheet ~= currentSheet then
			currentSheet = frame.sheet
			local sheet: SheetEntry = Manifest.sheets[currentSheet]
			if type(sheet.asset) == "string" then
				img.Image = sheet.asset
			end
		end

		img.ImageRectOffset = Vector2.new(frame.x, frame.y)
		img.ImageRectSize = Vector2.new(frame.w, frame.h)
	end)
end

local animName, anim = getFirstAnimation()
print(`[SpriteSheetPlayer] "{animName}" — {anim.frameCount} frames @ {anim.fps} fps`)

local _, img = createDisplay(animName, anim)
playAnimation(img, anim)
